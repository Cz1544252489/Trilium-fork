import { createHash } from "crypto";

import type { Request } from "express";

import { isValidAttributeName } from "@triliumnext/commons";
import type { BNote } from "@triliumnext/core";
import { becca, binary_utils as binaryUtils, getLog, options as optionService, utils, ValidationError } from "@triliumnext/core";

/**
 * Relocation moves a note's content out of this database and back. Trilium does the note work
 * itself — reading the content, changing the type, keeping the labels that find it again — and the
 * service it calls only stores bytes and hands back an address. The service therefore holds no
 * credentials for this database and knows nothing of notes.
 *
 * Where the content is needs no asking: a `file` note holds it, a `webView` note carrying
 * `relocationId` has it outside.
 */

/** How long one transfer is given; a large file takes tens of seconds to travel. */
const TRANSFER_TIMEOUT_MS = 300_000;

/** What a note is left as while its content lives elsewhere. Blank content would read as empty. */
const PLACEHOLDER_CONTENT = " ";

/** The id given to the single address earlier versions stored, so notes sent then can name it. */
const LEGACY_SERVICE_ID = "default";

interface Service {
    id: string;
    name: string;
    baseUrl: string;
    token: string;
}

/** One entry of the `contentRelocationServices` option, as the settings page writes it. */
interface StoredService {
    id?: string;
    name?: string;
    url?: string;
    token?: string;
}

interface StoredBlob {
    id: string;
    url: string;
    /** The service's checksum of what it stored, kept to verify the way back. */
    sha256?: string;
    /** How large the content is, kept to show while it is away. */
    size?: number;
}

async function move(req: Request<{ noteId: string }>) {
    const to = req.body?.to;
    if (to !== "local" && to !== "external") {
        throw new ValidationError("to must be 'local' or 'external'");
    }

    const note = becca.getNoteOrThrow(req.params.noteId);

    if (to === "external") {
        const service = defaultService();
        if (!service) {
            throw new ValidationError("Content relocation has no service configured");
        }
        return await moveOut(note, service);
    }

    const service = serviceFor(note);
    if (!service) {
        const target = note.getLabelValue("relocationTarget");
        throw new ValidationError(`The content of ${note.noteId} is on "${target}", which is not among the configured services`);
    }
    return await moveBack(note, service);
}

/**
 * Sends the content away and leaves the note showing it from there. The upload happens first: a
 * note that has lost its content while the upload failed would have lost it altogether.
 */
async function moveOut(note: BNote, service: Service) {
    if (note.type !== "file") {
        throw new ValidationError(`Note ${note.noteId} holds no content to move out`);
    }

    const content = note.getContent();
    const bytes = typeof content === "string" ? binaryUtils.encodeUtf8(content) : content;
    const mime = note.mime;
    const stored = await upload(service, note, bytes, mime);

    try {
        // The one thing the way back needs. Not the id — the protocol has the caller name it, and
        // this note's id is what was sent; not the mime either, which comes back as Content-Type.
        note.setLabel("relocationHash", shorten(stored.sha256 ?? sha256(bytes)));
        note.setLabel("relocationTarget", service.id);
        // Separate, and written the way it is read: the attribute panel shows a label as it stands,
        // and a bare byte count says little at a glance. Nothing depends on it.
        note.setLabel("relocationSize", utils.formatSize(stored.size ?? bytes.length));
        note.setLabel("webViewSrc", stored.url);
        // A knowledge base's own bookkeeping of where content sits, not part of the protocol above.
        const locationLabel = configuredLocationLabel();
        if (locationLabel) {
            note.setLabel(locationLabel, "false");
        }
        note.type = "webView";
        note.mime = "";
        note.save();
        note.setContent(PLACEHOLDER_CONTENT);
    } catch (e) {
        // The note is the record of where the content went. Without it the upload is unreachable,
        // so it is taken back rather than left behind.
        await remove(service, stored.id).catch((removeError) => {
            getLog().error(`Content relocation: could not undo the upload of ${note.noteId}: ${removeError}`);
        });
        throw e;
    }

    return { ok: true, log: `Moved ${bytes.length} bytes to ${service.name}.` };
}

/** Fetches the content back and restores the note to what it was before it left. */
async function moveBack(note: BNote, service: Service) {
    const recorded = readHash(note);
    if (recorded === null) {
        throw new ValidationError(`Note ${note.noteId} has no relocated content`);
    }

    // The id is the note's own: the protocol has the caller name it on the way out.
    const { bytes, mime, storedSha256 } = await download(service, note.noteId);
    verify(note, bytes, recorded, storedSha256);

    note.type = "file";
    note.mime = mime;
    note.save();
    note.setContent(bytes);
    note.removeLabel("webViewSrc");
    note.removeLabel("relocationHash");
    note.removeLabel("relocationTarget");
    note.removeLabel("relocationSize");
    // Written by earlier versions.
    note.removeLabel("relocationInfo");
    note.removeLabel("relocationId");
    note.removeLabel("relocationMime");
    note.removeLabel("relocationSha256");

    const locationLabel = configuredLocationLabel();
    if (locationLabel) {
        note.setLabel(locationLabel, "true");
    }

    // The copy outside is now a duplicate. Failing to remove it leaves a stray file, which is worth
    // reporting but not worth undoing a restore that has already succeeded.
    await remove(service, note.noteId).catch((e) => {
        getLog().error(`Content relocation: ${note.noteId} is back, but the copy outside remains: ${e}`);
    });

    return { ok: true, log: `Moved ${bytes.length} bytes back from ${service.name}.` };
}

async function upload(service: Service, note: BNote, bytes: Uint8Array, mime: string): Promise<StoredBlob> {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${service.token}`,
        "Content-Type": mime || "application/octet-stream",
        "X-Relocation-Note-Id": note.noteId
    };

    // Percent-encoded: a header value carries Latin-1 only, and a file name is as likely to be
    // Chinese as not. The service decodes it.
    const filename = note.getLabelValue("originalFileName");
    if (filename) {
        headers["X-Relocation-Filename"] = encodeURIComponent(filename);
    }

    const response = await fetch(`${service.baseUrl}blobs`, {
        method: "POST",
        headers,
        // Copied into a Buffer because `fetch` takes no typed array whose buffer might be shared.
        body: Buffer.from(bytes),
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
    if (typeof payload?.id !== "string" || typeof payload?.url !== "string") {
        throw new Error("The service answered without an id and a url");
    }
    return {
        id: payload.id,
        url: payload.url,
        sha256: typeof payload.sha256 === "string" ? payload.sha256 : undefined
    };
}

async function download(service: Service, id: string) {
    const response = await fetch(`${service.baseUrl}blobs/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${service.token}` },
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS)
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    // The note's mime is restored from this, so any parameters the header carries are dropped:
    // "application/pdf; charset=utf-8" is not a mime a note should end up with.
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();

    return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mime: contentType || "application/octet-stream",
        storedSha256: response.headers.get("x-blob-sha256") ?? undefined
    };
}

async function remove(service: Service, id: string) {
    const response = await fetch(`${service.baseUrl}blobs/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${service.token}` },
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS)
    });

    if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}`);
    }
}

/**
 * Every configured service, or nothing at all while relocation is switched off. The single address
 * earlier versions stored is read as one more entry, so an existing setup keeps working untouched.
 */
function readServices(): Service[] {
    if (!optionService.getOptionBool("contentRelocationEnabled")) {
        return [];
    }

    let stored: StoredService[] = [];
    try {
        const parsed = JSON.parse(optionService.getOption("contentRelocationServices") || "[]");
        stored = Array.isArray(parsed) ? parsed : [];
    } catch {
        // A damaged list is the same as an empty one; the legacy address below may still serve.
    }

    const services = stored
        .filter((entry) => entry?.id && entry?.url)
        .map((entry) => normalize(entry.id ?? "", entry.name ?? "", entry.url ?? "", tokenFor(entry)));

    if (!services.length) {
        const url = optionService.getOption("contentRelocationUrl").trim();
        if (url) {
            services.push(normalize(LEGACY_SERVICE_ID, LEGACY_SERVICE_ID, url, optionService.getOption("contentRelocationToken")));
        }
    }
    return services;
}

/** The service a note's content is sent to. */
function defaultService(): Service | null {
    const services = readServices();
    const wanted = optionService.getOption("contentRelocationDefault");
    return services.find((service) => service.id === wanted) ?? services[0] ?? null;
}

/**
 * The service holding one note's content. A note relocated before services could be named carries
 * no target, and its content is wherever the only service of the time was — the default.
 */
function serviceFor(note: BNote): Service | null {
    const target = note.getLabelValue("relocationTarget");
    if (!target) {
        return defaultService();
    }
    return readServices().find((service) => service.id === target) ?? null;
}

/**
 * The label name a knowledge base wants kept in step with where a note's content is, or null where
 * none is configured or the configured name is not one a label can carry. A bad name is treated the
 * same as none, so it cannot turn an otherwise successful relocation into a failure.
 */
function configuredLocationLabel(): string | null {
    const name = optionService.getOption("contentRelocationLocationLabel").trim();
    if (!name || !isValidAttributeName(name)) {
        return null;
    }
    return name;
}

/**
 * An entry's token. The one the settings page writes back for the legacy service is empty: the
 * option that holds it is write-only, so the page never saw it and cannot carry it over.
 */
function tokenFor(entry: StoredService): string {
    if (entry.token) {
        return entry.token;
    }
    if (entry.id === LEGACY_SERVICE_ID) {
        return optionService.getOption("contentRelocationToken");
    }
    return "";
}

function normalize(id: string, name: string, url: string, token: string): Service {
    const trimmed = url.trim();
    return {
        id,
        name: name || id,
        baseUrl: trimmed.endsWith("/") ? trimmed : `${trimmed}/`,
        token
    };
}

/**
 * The checksum this note recorded when its content left, or null when nothing left. Notes
 * relocated by earlier versions recorded it as a packed record or as a label of its own, and are
 * read that way too.
 */
function readHash(note: BNote): string | null {
    const hash = note.getLabelValue("relocationHash");
    if (hash) {
        return hash;
    }

    const packed = note.getLabelValue("relocationInfo");
    if (packed) {
        try {
            return JSON.parse(packed)?.sha256 ?? "";
        } catch {
            // A damaged record still says the content is outside; verify() covers the rest.
            return "";
        }
    }

    if (note.getLabelValue("relocationId")) {
        return note.getLabelValue("relocationSha256") ?? "";
    }
    return null;
}

/**
 * Checks the returned bytes against what this note recorded when the content left, and against
 * what the service says it holds. Those two disagreeing while the bytes match the service means
 * the note's own record was edited — the content is intact, and saying so is more useful than
 * refusing forever. Bytes that match neither are a damaged transfer, and stop the restore.
 */
function verify(note: BNote, bytes: Uint8Array, recorded: string, storedSha256: string | undefined) {
    const actual = sha256(bytes);
    if (storedSha256 && actual !== storedSha256) {
        throw new Error(`The content of ${note.noteId} arrived damaged: the service holds ${storedSha256} but ${actual} arrived. Nothing was changed.`);
    }

    // Compared over the recorded length: this end keeps a prefix, earlier versions kept all 64.
    if (!recorded || actual.startsWith(recorded)) {
        return;
    }
    if (storedSha256 && actual === storedSha256) {
        getLog().info(`Content relocation: ${note.noteId} carries a checksum of ${recorded} but the service holds ${actual}; the content is intact, so the record is being replaced.`);
        return;
    }
    throw new Error(`The content of ${note.noteId} does not match the checksum recorded when it left; nothing was changed`);
}

/**
 * How much of a checksum a note keeps. Sixty-four bits is far below what it takes to resist a
 * constructed collision, and far above what it takes to catch a damaged or replaced file, which
 * is all this guards against.
 */
function shorten(digest: string) {
    return digest.slice(0, 16);
}

/** The checksum both directions compare, so a round trip cannot silently alter the content. */
function sha256(bytes: Uint8Array) {
    return createHash("sha256").update(bytes).digest("hex");
}

export default {
    move
};
