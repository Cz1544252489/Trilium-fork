import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted alongside the mock factories, which run before this file's own top-level constants exist.
const mocks = vi.hoisted(() => ({
    serverPostWithTimeout: vi.fn<(url: string, timeoutMs: number, data?: unknown) => Promise<unknown>>(),
    toastShowError: vi.fn(),
    wsWait: vi.fn<() => Promise<void>>(async () => {}),
    optionEnabled: true,
    // Stand in for the note's own state, which is what says whether a move is on offer and which way.
    noteType: "file" as string,
    relocationHash: null as string | null,
    relocationInfo: null as string | null,
    relocationId: null as string | null
}));

vi.mock("../../services/server", () => ({
    default: {
        // `keyboard_actions.ts` calls `server.get("keyboard-actions")` at module scope, pulled in
        // transitively through the real, partially-mocked hooks module.
        get: async () => [],
        postWithTimeout: (url: string, timeoutMs: number, data?: unknown) => mocks.serverPostWithTimeout(url, timeoutMs, data)
    }
}));

vi.mock("../../services/toast", () => ({
    default: { showError: (msg: string) => mocks.toastShowError(msg), showMessage: vi.fn() }
}));

vi.mock("../../services/options", () => ({
    default: { is: () => mocks.optionEnabled, get: () => "", getInt: () => 0, getJson: () => null }
}));

// Partial mock: `tree.ts` subscribes to `ws` at module scope (pulled in transitively through the
// real, partially-mocked hooks module), so the rest of the real `ws` default export has to stay.
vi.mock("../../services/ws", async (importOriginal) => ({
    default: {
        ...(await importOriginal<typeof import("../../services/ws")>()).default,
        waitForMaxKnownEntityChangeId: () => mocks.wsWait()
    }
}));

// Partial mock: only the two note readers are overridden, everything else (useStaticTooltip, used
// by Button) stays real so the rest of the tree renders normally.
vi.mock("../react/hooks", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../react/hooks")>()),
    useNoteProperty: () => mocks.noteType,
    useNoteLabel: (_note: unknown, name: string) => [
        ({
            relocationHash: mocks.relocationHash,
            relocationInfo: mocks.relocationInfo,
            relocationId: mocks.relocationId
        } as Record<string, string | null>)[name] ?? null,
        vi.fn()
    ]
}));

// i18next is never initialized under test, so `t` echoes the key back and assertions check keys.
vi.mock("../../services/i18n", () => ({ t: (key: string) => key }));

import type FNote from "../../entities/fnote";
import { buildNote } from "../../test/easy-froca";
import ContentRelocationTab from "./ContentRelocationTab";

let container: HTMLDivElement | undefined;

async function renderTab(note: FNote | null) {
    const target = container ?? document.body.appendChild(document.createElement("div"));
    container = target;
    await act(async () => {
        render(<ContentRelocationTab note={note} />, target);
    });
    await flush();
    return target;
}

/** Drains the promises a click chains, so the state they set is rendered. */
async function flush() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
}

function unmount() {
    if (container) {
        render(null, container);
        container.remove();
        container = undefined;
    }
}

afterEach(() => {
    unmount();
    mocks.serverPostWithTimeout.mockReset();
    mocks.toastShowError.mockClear();
    mocks.wsWait.mockClear();
    mocks.optionEnabled = true;
    mocks.noteType = "file";
    mocks.relocationHash = null;
    mocks.relocationInfo = null;
    mocks.relocationId = null;
});

describe("ContentRelocationTab", () => {
    it("offers to send a file note's content away", async () => {
        const target = await renderTab(buildNote({ title: "Paper" }));

        expect(target.querySelector("button")?.textContent).toContain("content_relocation.move_out");
        expect(target.textContent).toContain("content_relocation.location_local");
    });

    it("offers to bring back a note whose content is outside", async () => {
        mocks.noteType = "webView";
        mocks.relocationHash = "2528d9cfb96e82df";

        const target = await renderTab(buildNote({ title: "Paper" }));

        expect(target.querySelector("button")?.textContent).toContain("content_relocation.move_back");
        expect(target.textContent).toContain("content_relocation.external_storage");
    });

    it("offers to bring back a note relocated by an earlier version", async () => {
        // Those notes carry a packed record, or one label per field, instead of relocationHash.
        mocks.noteType = "webView";
        mocks.relocationId = "someNoteId";

        const target = await renderTab(buildNote({ title: "Paper" }));

        expect(target.querySelector("button")?.textContent).toContain("content_relocation.move_back");
    });

    it("offers nothing on a web view that relocation never touched", async () => {
        mocks.noteType = "webView";

        const target = await renderTab(buildNote({ title: "A bookmarked page" }));

        expect(target.querySelector("button")).toBeNull();
    });

    it("offers nothing while relocation is switched off", async () => {
        mocks.optionEnabled = false;

        const target = await renderTab(buildNote({ title: "Paper" }));

        expect(target.querySelector("button")).toBeNull();
    });

    it("moves the content out and displays the returned log", async () => {
        mocks.serverPostWithTimeout.mockResolvedValue({ ok: true, log: "Moved 2048 bytes out of the database." });
        const note = buildNote({ title: "Paper" });

        const target = await renderTab(note);
        const button = target.querySelector("button");
        expect(button).not.toBeNull();

        await act(async () => {
            button?.click();
        });
        await flush();

        expect(mocks.serverPostWithTimeout).toHaveBeenCalledWith(
            `content-relocation/move/${note.noteId}`,
            expect.any(Number),
            { to: "external" }
        );
        expect(mocks.wsWait).toHaveBeenCalled();
        expect(target.textContent).toContain("Moved 2048 bytes out of the database.");
    });

    it("reports a failed move without throwing", async () => {
        mocks.noteType = "webView";
        mocks.relocationHash = "2528d9cfb96e82df";
        mocks.serverPostWithTimeout.mockResolvedValue({ ok: false, log: "HTTP 500", error: "connection refused" });

        const target = await renderTab(buildNote({ title: "Paper" }));
        const button = target.querySelector("button");
        expect(button).not.toBeNull();

        await act(async () => {
            button?.click();
        });
        await flush();

        expect(mocks.serverPostWithTimeout).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(Number),
            { to: "local" }
        );
        expect(mocks.toastShowError).toHaveBeenCalledWith("connection refused");
    });
});
