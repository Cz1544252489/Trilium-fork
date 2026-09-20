import "./database.css";

import {
    AnonymizedDbResponse,
    DatabaseAnonymizeResponse,
    DatabaseCheckIntegrityResponse,
    DatabaseInfoResponse,
    ExistingAnonymizedDatabasesResponse,
    ExistingBackupsResponse
} from "@triliumnext/commons";
import { useCallback, useEffect, useState } from "preact/hooks";
import type React from "react";
import { Trans } from "react-i18next";

import appContext from "../../../components/app_context";
import { isBackupDownloadSupported } from "../../../services/backup_download";
import { summarizeBackups } from "../../../services/database_files";
import dialogService, { closeActiveDialog } from "../../../services/dialog";
import { t } from "../../../services/i18n";
import server from "../../../services/server";
import {
    canBootToSetup,
    cancelStartOver,
    isStartOverPending,
    startOver
} from "../../../services/setup_mode";
import toast from "../../../services/toast";
import { formatSize, isStandalone, randomString } from "../../../services/utils";
import { formatDateTime } from "../../../utils/formatters";
import ActionButton from "../../react/ActionButton";
import Admonition from "../../react/Admonition";
import { Badge } from "../../react/Badge";
import Button from "../../react/Button";
import { Card, CardSection, OptionCardSection } from "../../react/Card";
import DirectoryLink, { FileLink } from "../../react/DirectoryLink";
import FormTextBox from "../../react/FormTextBox";
import FormToggle from "../../react/FormToggle";
import { PageLink } from "../../react/LinkButton";
import NoItems from "../../react/NoItems";
import { useTriliumOption, useTriliumOptionBool, useTriliumOptionJson } from "../../react/hooks";
import { useFetch } from "../../react/use_fetch";
import { showCleanupDialog } from "../space_usage/cleanup_dialog";
import DatabaseFileList from "./components/DatabaseFileList";
import OptionsPageHeader from "./components/OptionsPageHeader";
import RelatedSettings from "./components/RelatedSettings";
import HelpButton from "../../react/HelpButton";

/**
 * What can be done to the knowledge base as a whole, rather than to anything inside it: keeping the
 * database sound, replacing it altogether, and handing a copy of it to someone else with the
 * contents taken out.
 *
 * Starting over follows the maintenance it is the last resort of; anonymized copies come after both,
 * being for somebody else's benefit rather than this database's.
 */
export default function DatabaseSettings() {
    const startOverState = useStartOver();
    // The space and maintenance actions change what `DatabaseInfo` states, so bumping this token
    // makes it read the figures again.
    const [ infoToken, setInfoToken ] = useState(0);
    const refreshInfo = useCallback(() => setInfoToken((token) => token + 1), []);

    return (
        <>
            <OptionsPageHeader />

            {/* Above the cards rather than under the button that caused it: a request left standing
                is the state of the whole page from here on, and the first thing its owner needs to
                know when they open this page again. */}
            {startOverState.pending && (
                <Admonition type="warning" className="start-over-pending">
                    <p>{t("database.start_over_pending")}</p>

                    <Button
                        name="cancel-start-over-button"
                        text={t("database.start_over_cancel")}
                        size="micro"
                        disabled={startOverState.busy}
                        onClick={() => void startOverState.cancel()}
                    />
                </Admonition>
            )}

            <DatabaseInfo refreshToken={infoToken} />
            <SpaceOptions onDatabaseChanged={refreshInfo} />
            <MaintenanceOptions onDatabaseChanged={refreshInfo} />
            <ContentRelocationOptions />
            <StartOverOption state={startOverState} />
            {/* An anonymized copy is a file written beside the database and handed to someone else.
                The browser build has nowhere to write one and no database file to copy. */}
            {!isStandalone && <AnonymizationOptions />}

            <RelatedSettings items={[
                {
                    title: t("database.related_backup"),
                    description: t("database.related_backup_description"),
                    targetPage: "_optionsBackup"
                }
            ]} />
        </>
    );
}

/** One entry of `contentRelocationServices`, kept in sync with the server's `StoredService`. */
interface ContentRelocationServiceConfig {
    id: string;
    name: string;
    url: string;
    token: string;
}

/**
 * The id (and shown name) the server carries the single pre-multi-service address forward under,
 * once there is a list for it to join. Must stay exactly "default" — content already moved out under
 * it recorded that id on its note, and a different one here would orphan it.
 */
const LEGACY_SERVICE_ID = "default";

/**
 * Relocation hands a note's content to an external service, which keeps it outside this database and
 * gives it back on request. Several services can be configured — a home machine, one on the local
 * network, one reachable from outside it — and one of them is sent to when no note says otherwise.
 *
 * `contentRelocationUrl` / `contentRelocationToken` are the single address earlier versions could
 * configure. They are left untouched here and, while `contentRelocationServices` is still empty,
 * shown as one more service named `LEGACY_SERVICE_ID` — the same id the server falls back to, so
 * content already moved out under it keeps finding its way back. Adding or removing a service carries
 * that entry into `contentRelocationServices` for good, the same as any other change to the list.
 *
 * Exported so its own spec can mount it without the rest of the page's cards.
 */
export function ContentRelocationOptions() {
    const [ enabled, setEnabled ] = useTriliumOptionBool("contentRelocationEnabled");
    const [ storedServices, setStoredServices ] = useTriliumOptionJson<ContentRelocationServiceConfig[]>("contentRelocationServices");
    const [ defaultId, setDefaultId ] = useTriliumOption("contentRelocationDefault");
    const [ legacyUrl ] = useTriliumOption("contentRelocationUrl");
    const [ legacyToken ] = useTriliumOption("contentRelocationToken");
    const [ locationLabel, setLocationLabel ] = useTriliumOption("contentRelocationLocationLabel");
    const [ adding, setAdding ] = useState(false);

    const services = storedServices.length > 0
        ? storedServices
        // `useTriliumOption` can still answer "" (or, on the very first render, `undefined`) while
        // the option cache is loading, before the legacy address is known one way or the other.
        : ((legacyUrl ?? "").trim()
            ? [ { id: LEGACY_SERVICE_ID, name: LEGACY_SERVICE_ID, url: legacyUrl, token: legacyToken ?? "" } ]
            : []);

    // `contentRelocationDefault` can name nothing (never set) or a service that was since removed;
    // the server then falls back to the first configured one (see `defaultService` in
    // `content_relocation.ts`), so the page reads the same way rather than showing no default where
    // one is already in effect.
    const effectiveDefaultId = services.some((service) => service.id === defaultId)
        ? defaultId
        : (services[0]?.id ?? "");

    function addService(name: string, url: string, token: string) {
        setStoredServices([ ...services, { id: randomString(), name, url, token } ]);
        setAdding(false);
    }

    async function removeService(service: ContentRelocationServiceConfig) {
        if (!await dialogService.confirm(t("content_relocation.delete_confirmation", { name: service.name }))) {
            return;
        }

        const remaining = services.filter((candidate) => candidate.id !== service.id);
        setStoredServices(remaining);
        if (effectiveDefaultId === service.id) {
            setDefaultId(remaining[0]?.id ?? "");
        }
    }

    return (
        <Card className="content-relocation" heading={t("content_relocation.title")}>
            <OptionCardSection
                label={t("content_relocation.settings_enabled")}
                description={t("content_relocation.settings_description")}
            >
                <FormToggle
                    switchOnName={t("content_relocation.settings_enabled")}
                    switchOffName={t("content_relocation.settings_enabled")}
                    currentValue={enabled}
                    onChange={setEnabled}
                />
            </OptionCardSection>

            {enabled && (
                <>
                    {services.length > 0 ? (
                        services.map((service) => (
                            <OptionCardSection
                                key={service.id}
                                label={
                                    <span className="content-relocation-service-name">
                                        {service.name}
                                        {service.id === effectiveDefaultId && (
                                            <Badge text={t("content_relocation.default_badge")} />
                                        )}
                                    </span>
                                }
                                description={
                                    <span className="content-relocation-service-url">{service.url}</span>
                                }
                            >
                                <span className="tn-card-option-actions">
                                    {/* Only reachable once a second service exists: while the list
                                        holds just the address carried over from before, that one
                                        entry already reads as the default and needs no button of its
                                        own to become it. */}
                                    {service.id !== effectiveDefaultId && (
                                        <ActionButton
                                            icon="bx bx-star"
                                            text={t("content_relocation.set_default")}
                                            onClick={() => setDefaultId(service.id)}
                                        />
                                    )}
                                    <ActionButton
                                        className="destructive-action-icon"
                                        icon="bx bx-trash"
                                        text={t("content_relocation.delete_service")}
                                        onClick={() => void removeService(service)}
                                    />
                                </span>
                            </OptionCardSection>
                        ))
                    ) : (
                        <CardSection>
                            <NoItems icon="bx bx-server" text={t("content_relocation.no_services")} size="small" />
                        </CardSection>
                    )}

                    {adding ? (
                        <AddContentRelocationServiceForm
                            onAdd={addService}
                            onCancel={() => setAdding(false)}
                        />
                    ) : (
                        <CardSection>
                            <Button
                                name="add-content-relocation-service-button"
                                text={t("content_relocation.add_service")}
                                icon="bx-plus"
                                size="micro"
                                onClick={() => setAdding(true)}
                            />
                        </CardSection>
                    )}

                    {/* A knowledge base's own convention for "where is this note's content", kept
                        outside the relocation protocol itself: the name is this database's to pick,
                        so it is a label the server writes rather than one it assumes. */}
                    <OptionCardSection
                        name="content-relocation-location-label"
                        label={t("content_relocation.settings_location_label")}
                        description={t("content_relocation.settings_location_label_description")}
                        stacked
                    >
                        <FormTextBox
                            placeholder="IsLocal"
                            currentValue={locationLabel}
                            onBlur={setLocationLabel}
                        />
                    </OptionCardSection>
                </>
            )}
        </Card>
    );
}

/**
 * The fields for a new service, expanded below the list rather than in a dialog: three plain text
 * inputs are not worth a modal for.
 */
function AddContentRelocationServiceForm({ onAdd, onCancel }: {
    onAdd: (name: string, url: string, token: string) => void;
    onCancel: () => void;
}) {
    const [ name, setName ] = useState("");
    const [ url, setUrl ] = useState("");
    const [ token, setToken ] = useState("");
    const canAdd = name.trim().length > 0 && url.trim().length > 0;

    return (
        <>
            <OptionCardSection
                name="content-relocation-new-name"
                label={t("content_relocation.service_name")}
                description={t("content_relocation.service_name_description")}
                stacked
            >
                <FormTextBox currentValue={name} onChange={setName} />
            </OptionCardSection>

            <OptionCardSection
                name="content-relocation-new-url"
                label={t("content_relocation.settings_url")}
                description={t("content_relocation.settings_url_description")}
                stacked
            >
                <FormTextBox
                    placeholder="http://127.0.0.1:37862/"
                    currentValue={url}
                    onChange={setUrl}
                />
            </OptionCardSection>

            <OptionCardSection
                name="content-relocation-new-token"
                label={t("content_relocation.settings_token")}
                description={t("content_relocation.settings_token_description")}
                stacked
            >
                <FormTextBox type="password" currentValue={token} onChange={setToken} />
            </OptionCardSection>

            <CardSection className="content-relocation-add-actions">
                <Button
                    name="confirm-add-content-relocation-service-button"
                    text={t("common.save")}
                    kind="primary"
                    size="micro"
                    disabled={!canAdd}
                    onClick={() => onAdd(name.trim(), url.trim(), token)}
                />
                <Button
                    name="cancel-add-content-relocation-service-button"
                    text={t("common.cancel")}
                    size="micro"
                    onClick={onCancel}
                />
            </CardSection>
        </>
    );
}

/**
 * What the database is, before anything is done to it: where its file is, how far back it goes, how
 * much it holds and how large it has grown.
 *
 * Nothing is shown until the figures arrive, and nothing at all where they cannot be had. A card of
 * empty rows would state no less than a card that is not there, and rather less clearly.
 */
function DatabaseInfo({ refreshToken }: { refreshToken: number }) {
    const { data: info } = useFetch<DatabaseInfoResponse>("database/info", refreshToken);

    if (!info) {
        return null;
    }

    return (
        <Card className="database-info" heading={t("database.info")}>
            <OptionCardSection label={t("database.info_location")}>
                <span className="tn-card-option-value">
                    {/* Revealed rather than opened: a file manager is what a path is useful in,
                        and the database's own reader is Trilium. Where there is no path, the
                        storage holding it is named instead — nothing there can be pointed at. */}
                    {info.filePath
                        ? <FileLink filePath={info.filePath} />
                        : t("database.info_location_opfs")}
                </span>
            </OptionCardSection>

            {/* Follows the storage it qualifies, and only where that storage is the browser's:
                a database on disk stays there whatever the browser thinks of it. */}
            {isStandalone && <StoragePersistence refreshToken={refreshToken} />}

            <OptionCardSection label={t("database.info_content")}>
                <span className="tn-card-option-value">
                    {t("database.info_notes", { count: info.noteCount })}
                    {", "}
                    {t("database.info_attachments", { count: info.attachmentCount })}
                </span>
            </OptionCardSection>

            <OptionCardSection label={t("database.info_created")}>
                <span className="tn-card-option-value">
                    {formatDateTime(info.utcDateCreated, "long", "none")}
                </span>
            </OptionCardSection>

            <OptionCardSection label={t("database.info_size")}>
                <span className="tn-card-option-value">{formatSize(info.sizeBytes)}</span>
            </OptionCardSection>

            {/* Absent where backups are not kept at all: the browser build's one backup is a
                download, taken there and then, so there is nothing standing to state. */}
            {!isBackupDownloadSupported() && <BackupStanding refreshToken={refreshToken} />}
        </Card>
    );
}

/**
 * Whether the browser has undertaken to keep the storage the database lives in. Standalone asks for
 * that undertaking at every startup, and the browser decides from its own heuristics — chiefly how
 * installed the site looks — so this states the answer and what follows from it.
 *
 * Read from the page rather than from `database/info`, which is answered by core: `persisted()` is
 * the browser's own reading of its own storage, and there is nothing in the database to base it on.
 * Nothing is shown where the browser does not report it, which is every build whose database is a
 * file on disk.
 *
 * Read again on `refreshToken`, like the figures beside it: the startup request can still be in
 * flight when this mounts, and the browser is free to change its mind afterwards.
 */
function StoragePersistence({ refreshToken }: { refreshToken: number }) {
    const [ persisted, setPersisted ] = useState<boolean | null>(null);

    useEffect(() => {
        let current = true;
        navigator.storage?.persisted?.()
            .then((result) => { if (current) setPersisted(result); })
            .catch(() => {});

        return () => { current = false; };
    }, [ refreshToken ]);

    if (persisted === null) {
        return null;
    }

    return (
        <OptionCardSection
            className="database-persistence"
            label={t("database.info_persistence")}
            description={persisted
                ? t("database.info_persistence_persistent_description")
                : t("database.info_persistence_best_effort_description")}
        >
            <span className="tn-card-option-value">
                {persisted
                    ? t("database.info_persistence_persistent")
                    : t("database.info_persistence_best_effort")}
            </span>
        </OptionCardSection>
    );
}

/**
 * How the backups stand, and the way to the page that acts on them.
 *
 * The backups are the one thing on this page it does nothing about, so they are read from the page
 * that does — the same listing, summarized by the same sentence its own header carries.
 */
function BackupStanding({ refreshToken }: { refreshToken: number }) {
    const { data: backups } = useFetch<ExistingBackupsResponse>("database/backups", refreshToken);

    if (!backups) {
        return null;
    }

    return (
        <OptionCardSection label={t("database.info_backup")}>
            {/* The whole value is the way to the page that acts on it: this row states how the
                backups stand, and everything else about them is done there. */}
            <span className="tn-card-option-value">
                <PageLink
                    href={BACKUP_PAGE_LINK}
                    text={summarizeBackups(backups.backups) ?? t("database.info_no_backup")}
                />
            </span>
        </OptionCardSection>
    );
}

/** A note path, which is how one options page links to another. */
const BACKUP_PAGE_LINK = "#root/_hidden/_options/_optionsBackup";

/**
 * Entry points to the two space tools: the Space Usage page reports where the space went, and
 * `showCleanupDialog()` reclaims it. Analysis comes first because it informs the cleanup.
 *
 * Headingless, since it continues the figures in `DatabaseInfo`. It is a separate card because
 * `DatabaseInfo` renders nothing until `database/info` resolves, and these actions must stay
 * available when that request is slow or fails.
 */
function SpaceOptions({ onDatabaseChanged }: { onDatabaseChanged: () => void }) {
    return (
        <Card className="database-space">
            <OptionCardSection
                label={t("database.analyze_space_usage")}
                description={t("database.analyze_space_usage_description")}
            >
                <Button
                    name="analyze-space-usage-button"
                    text={t("database.analyze_space_usage_button")}
                    size="micro"
                    onClick={() => {
                        // Space Usage opens in its own tab, so close the options dialog first;
                        // it would otherwise cover the tab.
                        closeActiveDialog();
                        void appContext.triggerCommand("showSpaceUsage");
                    }}
                />
            </OptionCardSection>

            <OptionCardSection
                label={t("database.cleanup")}
                description={t("database.cleanup_description")}
            >
                {/* Reuses the dialog's own title so the two cannot disagree. */}
                <Button
                    name="cleanup-button"
                    text={t("space_usage.cleanup_title")}
                    size="micro"
                    onClick={() => void showCleanupDialog().then((reclaimed) => {
                        // Erasing changes the note and attachment counts, so `DatabaseInfo`
                        // reads them again.
                        if (reclaimed !== null) {
                            onDatabaseChanged();
                        }
                    })}
                />
            </OptionCardSection>
        </Card>
    );
}

/**
 * Repairs that act on the database file rather than on its contents: consistency checks, SQLite's
 * `integrity_check`, and `VACUUM`.
 *
 * These are troubleshooting tools, so they sit below `SpaceOptions`, which holds the actions most
 * users come to this page for.
 */
function MaintenanceOptions({ onDatabaseChanged }: { onDatabaseChanged: () => void }) {
    return (
        <Card heading={t("database.maintenance")}>
            <OptionCardSection
                label={t("consistency_checks.find_and_fix_label")}
                description={t("consistency_checks.find_and_fix_description")}
            >
                <Button
                    name="fix-consistency-issues-button"
                    text={t("consistency_checks.find_and_fix_button")}
                    size="micro"
                    onClick={fixConsistencyIssues}
                />
            </OptionCardSection>

            <OptionCardSection
                label={t("database_integrity_check.check_integrity_label")}
                description={t("database_integrity_check.check_integrity_description")}
            >
                <Button
                    name="check-integrity-button"
                    text={t("database_integrity_check.check_button")}
                    size="micro"
                    onClick={checkIntegrity}
                />
            </OptionCardSection>

            {/* Offered everywhere the rebuild has somewhere to happen. The browser build keeps
                the temporary store in memory, so compacting would ask it for the size of the
                database over again at the very moment there is too little room — which is why
                the cleanup tool leaves compaction out there as well. */}
            {!isStandalone && (
                <OptionCardSection
                    label={t("vacuum_database.vacuum_label")}
                    description={t("vacuum_database.vacuum_description")}
                >
                    <Button
                        name="vacuum-database-button"
                        text={t("vacuum_database.button_text")}
                        size="micro"
                        onClick={async () => {
                            await vacuumDatabase();
                            onDatabaseChanged();
                        }}
                    />
                </OptionCardSection>
            )}
        </Card>
    );
}

/** Reports back either a clean bill of health, or whatever SQLite found, which is worth reading. */
async function checkIntegrity() {
    toast.showMessage(t("database_integrity_check.checking_integrity"));

    const { results } = await server.get<DatabaseCheckIntegrityResponse>("database/check-integrity");

    if (results.length === 1 && results[0].integrity_check === "ok") {
        toast.showMessage(t("database_integrity_check.integrity_check_succeeded"));
    } else {
        toast.showMessage(t("database_integrity_check.integrity_check_failed", { results: JSON.stringify(results, null, 2) }), 15000);
    }
}

async function fixConsistencyIssues() {
    toast.showMessage(t("consistency_checks.finding_and_fixing_message"));
    await server.post("database/find-and-fix-consistency-issues");
    toast.showMessage(t("consistency_checks.issues_fixed_message"));
}

async function vacuumDatabase() {
    toast.showMessage(t("vacuum_database.vacuuming_database"));
    // A rebuild runs in minutes on a large database — half an hour on 36 GiB — so the default
    // minute would report a failure for something still succeeding.
    await server.postWithTimeout("database/vacuum-database", VACUUM_TIMEOUT_MS);
    toast.showMessage(t("vacuum_database.database_vacuumed"));
}

/** Rebuilding runs in minutes on a large database, and the client must not give up before it ends. */
const VACUUM_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Copies of the database made to be handed out: the contents are taken out, so that what is left
 * says how the knowledge base is put together without saying what is in it.
 *
 * The copies are kept as files beside the database, so the list below the actions is the only place
 * they can be reached from once the toast that announced them is gone.
 */
function AnonymizationOptions() {
    const [databases, setDatabases] = useState<AnonymizedDbResponse[]>([]);
    const [anonymizedFolderPath, setAnonymizedFolderPath] = useState<string | null>(null);
    const [anonymizationInProgress, setAnonymizationInProgress] = useState(false);

    const refreshAnonymizedDatabases = useCallback(() => {
        server.get<ExistingAnonymizedDatabasesResponse>("database/anonymized-databases").then((response) => {
            setDatabases(response.databases);
            setAnonymizedFolderPath(response.anonymizedFolderPath);
        });
    }, []);

    useEffect(refreshAnonymizedDatabases, []);

    async function anonymize(type: "full" | "light") {
        setAnonymizationInProgress(true);
        try {
            toast.showMessage(type === "full"
                ? t("database_anonymization.creating_fully_anonymized_database")
                : t("database_anonymization.creating_lightly_anonymized_database"));
            const resp = await server.post<DatabaseAnonymizeResponse>(`database/anonymize/${type}`);

            if (!resp.success) {
                toast.showError(t("database_anonymization.error_creating_anonymized_database"));
                return;
            }

            toast.showMessage(type === "full"
                ? t("database_anonymization.successfully_created_fully_anonymized_database", { anonymizedFilePath: resp.anonymizedFilePath })
                : t("database_anonymization.successfully_created_lightly_anonymized_database", { anonymizedFilePath: resp.anonymizedFilePath }), 10000);
            refreshAnonymizedDatabases();
        } finally {
            setAnonymizationInProgress(false);
        }
    }

    /**
     * A copy is made to be handed out, and is of no further use once it has been: it is the one
     * thing on this page that can be thrown away without losing anything, and the only way to do so
     * short of the file manager.
     */
    async function remove(file: AnonymizedDbResponse) {
        if (!await dialogService.confirm(t("database_anonymization.delete_confirmation", { fileName: file.fileName }))) {
            return;
        }

        await server.remove(`database/anonymized?filePath=${encodeURIComponent(file.filePath)}`);
        refreshAnonymizedDatabases();
    }

    return (
        <>
            <Card className="database-anonymization"
                heading={t("database_anonymization.title")}
                description={t("database_anonymization.description")}
                actions={<HelpButton helpPage="x59R8J8KV5Bp" />}
            >
                <OptionCardSection
                    label={t("database_anonymization.full_anonymization")}
                    description={t("database_anonymization.full_anonymization_description")}
                >
                    <Button
                        name="full-anonymization-button"
                        text={t("database_anonymization.save_fully_anonymized_database")}
                        size="micro"
                        disabled={anonymizationInProgress}
                        onClick={() => void anonymize("full")}
                    />
                </OptionCardSection>

                <OptionCardSection
                    label={t("database_anonymization.light_anonymization")}
                    description={t("database_anonymization.light_anonymization_description")}
                >
                    <Button
                        name="light-anonymization-button"
                        text={t("database_anonymization.save_lightly_anonymized_database")}
                        size="micro"
                        disabled={anonymizationInProgress}
                        onClick={() => void anonymize("light")}
                    />
                </OptionCardSection>
            </Card>

            {/* Where the copies are kept is stated only once there is one to find there: an empty
                list saying where it would have been answers a question nobody asked. */}
            <DatabaseFileList
                title={t("database_anonymization.existing_anonymized_databases")}
                description={databases.length > 0 && anonymizedFolderPath && (
                    <Trans
                        i18nKey="database_anonymization.anonymized_databases_location"
                        // Kept beside the component: a locale still carrying the placeholder from
                        // before the folder became a link states the path as text rather than
                        // losing it, until its own translation catches up.
                        values={{ anonymizedFolder: anonymizedFolderPath }}
                        components={{
                            Folder: <DirectoryLink directory={anonymizedFolderPath} /> as React.ReactElement
                        }}
                    />
                )}
                files={databases}
                downloadEndpoint="api/database/anonymized/download"
                downloadText={t("database_anonymization.download")}
                onDelete={remove}
                emptyIcon="bx bx-glasses"
                emptyText={t("database_anonymization.no_anonymized_database_yet")}
            />
        </>
    );
}

/** Headingless: the row names the feature itself, and nothing else belongs beside it. */
function StartOverOption({ state }: { state: ReturnType<typeof useStartOver> }) {
    return (
        <Card className="start-over">
            <OptionCardSection
                label={t("database.start_over")}
                description={t("database.start_over_description")}
            >
                <Button
                    name="start-over-button"
                    text={t("database.start_over")}
                    icon="bx-reset"
                    size="micro"
                    disabled={state.busy || state.pending}
                    onClick={() => void state.begin()}
                />
            </OptionCardSection>
        </Card>
    );
}

/**
 * Going back to the setup screen, from where the knowledge base can be replaced.
 *
 * Two shapes, decided by whether the instance can restart itself. The desktop and the browser-only
 * build go there and then, so pressing the button is the whole of it. A server is restarted by
 * whoever runs it, so the request outlives the page that made it, and the page has to say that a
 * start-over is waiting and offer to call it off.
 *
 * Held by the page rather than by the row it belongs to, since the notice about a standing request
 * is the state of the whole page and sits at the top of it.
 */
function useStartOver() {
    const [ pending, setPending ] = useState(false);
    const [ busy, setBusy ] = useState(false);

    useEffect(() => {
        // Only ever true where nothing acts on the request until a human restarts the server, which
        // is also the only place the answer is worth waiting for.
        if (canBootToSetup()) {
            return;
        }

        void isStartOverPending().then(setPending).catch(() => {
            // The page still works without knowing; the button is what it is for.
        });
    }, []);

    async function begin() {
        setBusy(true);
        try {
            setPending(await startOver() === "pending");
        } finally {
            setBusy(false);
        }
    }

    async function cancel() {
        setBusy(true);
        try {
            await cancelStartOver();
            setPending(false);
        } finally {
            setBusy(false);
        }
    }

    return { pending, busy, begin, cancel };
}
