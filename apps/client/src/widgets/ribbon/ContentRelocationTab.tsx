import "./ContentRelocationTab.css";

import { useState } from "preact/hooks";

import { t } from "../../services/i18n";
import options from "../../services/options";
import server from "../../services/server";
import toast from "../../services/toast";
import { getErrorMessage } from "../../services/utils";
import ws from "../../services/ws";
import Button from "../react/Button";
import { useNoteLabel, useNoteProperty } from "../react/hooks";
import { TabContext } from "./ribbon-interface";

/**
 * Relocation hands a note's content to an external service and brings it back. Where the content is
 * needs no asking: a `file` note holds it, a `webView` note carrying `relocationId` has it outside.
 */

/** A move can take minutes, so it gets the timeout the repository uses for long operations. */
const MOVE_TIMEOUT_MS = 60 * 60 * 1000;

interface RelocationResult {
    ok: boolean;
    log: string;
    error?: string;
}

export default function ContentRelocationTab({ note }: Pick<TabContext, "note">) {
    const { offered, isLocal } = useRelocation(note);
    const [ relocationSize ] = useNoteLabel(note, "relocationSize");
    const [ relocationTarget ] = useNoteLabel(note, "relocationTarget");
    const [ moving, setMoving ] = useState(false);
    const [ log, setLog ] = useState<string | null>(null);

    async function onMove() {
        if (!note) return;

        setMoving(true);
        setLog(null);
        try {
            const result = await relocate(note.noteId, isLocal ? "external" : "local");
            setLog(result.log);
            if (!result.ok) {
                toast.showError(result.error ?? result.log);
            }
        } catch (e) {
            toast.showError(getErrorMessage(e));
        } finally {
            setMoving(false);
        }
    }

    return (
        <div className="content-relocation-widget">
            {offered && (
                <>
                    <table className="content-relocation-table">
                        <tbody>
                            <tr>
                                <th className="text-nowrap">{t("content_relocation.location")}:</th>
                                <td className="selectable-text">
                                    {isLocal
                                        ? t("content_relocation.location_local")
                                        : (relocationTarget || t("content_relocation.external_storage"))}
                                </td>
                            </tr>
                            {!isLocal && relocationSize && (
                                <tr>
                                    <th className="text-nowrap">{t("content_relocation.size")}:</th>
                                    <td className="selectable-text">{relocationSize}</td>
                                </tr>
                            )}
                        </tbody>
                    </table>

                    <div className="content-relocation-buttons">
                        <Button
                            icon="bx bx-transfer"
                            kind="primary"
                            disabled={moving}
                            text={moving
                                ? t("content_relocation.moving")
                                : (isLocal
                                    ? t("content_relocation.move_out", { storage: t("content_relocation.external_storage") })
                                    : t("content_relocation.move_back"))}
                            onClick={() => void onMove()}
                        />
                    </div>

                    {log && <pre className="content-relocation-log selectable-text">{log}</pre>}
                </>
            )}
        </div>
    );
}

/**
 * Whether this note can be moved, and which way. A `file` note's content is in the database and can
 * go out; a `webView` note that carries `relocationId` has content waiting to come back. Everything
 * else, and every note at all while relocation is switched off, is offered nothing.
 */
export function useRelocation(note: TabContext["note"]) {
    const noteType = useNoteProperty(note, "type");
    const [ relocationHash ] = useNoteLabel(note, "relocationHash");
    // Written by earlier versions, and still the mark of content waiting outside.
    const [ relocationInfo ] = useNoteLabel(note, "relocationInfo");
    const [ relocationId ] = useNoteLabel(note, "relocationId");

    const enabled = options.is("contentRelocationEnabled");
    const isLocal = noteType === "file";
    const isOutside = noteType === "webView" && !!(relocationHash || relocationInfo || relocationId);

    return { offered: enabled && (isLocal || isOutside), isLocal };
}

/**
 * Moves one note's content and waits for the resulting entity change, so callers that read the
 * note's type or labels re-render once this resolves.
 */
export async function relocate(noteId: string, to: "local" | "external") {
    const result = await server.postWithTimeout<RelocationResult>(
        `content-relocation/move/${noteId}`,
        MOVE_TIMEOUT_MS,
        { to }
    );

    await ws.waitForMaxKnownEntityChangeId();
    return result;
}
