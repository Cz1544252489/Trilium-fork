import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A row of `contentRelocationServices`, mirrored from the shape the component itself declares. */
interface TestService {
    id: string;
    name: string;
    url: string;
    token: string;
}

// t() returns the key (plus its params, where there are any) so assertions are deterministic and
// not tied to English text.
vi.mock("../../../services/i18n", () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key)
}));

vi.mock("react-i18next", () => ({
    Trans: ({ i18nKey }: { i18nKey: string }) => <span data-i18n-key={i18nKey} />
}));

const setupMode = vi.hoisted(() => ({
    canBootToSetup: vi.fn(() => true),
    startOver: vi.fn(async () => "restarting" as string),
    isStartOverPending: vi.fn(async () => false),
    cancelStartOver: vi.fn(async () => {})
}));
vi.mock("../../../services/setup_mode", () => setupMode);

vi.mock("../../../services/backup_download", () => ({ isBackupDownloadSupported: () => false }));

/** Ids handed out in the order the component asks for one, so an added service is found by it. */
const randomIds = vi.hoisted(() => ({ nextIndex: 0 }));
vi.mock("../../../services/utils", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../services/utils")>()),
    // A getter, since the real one is read from `window.glob` when the module loads.
    get isStandalone() { return false; },
    randomString: () => `generated-id-${++randomIds.nextIndex}`
}));

const server = vi.hoisted(() => ({
    get: vi.fn(async () => []),
    post: vi.fn(async () => ({})),
    postWithTimeout: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({}))
}));
vi.mock("../../../services/server", () => ({ default: server }));

/** Deleting a service is asked about first; the answer is the test's to give. */
const dialog = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock("../../../services/dialog", () => ({ default: dialog, closeActiveDialog: vi.fn() }));

vi.mock("../../../components/app_context", () => ({ default: { triggerCommand: vi.fn(async () => {}) } }));
vi.mock("../../../services/toast", () => ({ default: { showMessage: vi.fn(), showError: vi.fn() } }));
vi.mock("./components/OptionsPageHeader", () => ({ default: () => null }));
vi.mock("../space_usage/cleanup_dialog", () => ({ showCleanupDialog: vi.fn(async () => null) }));

/** What each option currently holds; every test starts from relocation on and nothing configured. */
const options = vi.hoisted(() => ({
    enabled: true,
    services: [] as TestService[],
    defaultId: "",
    legacyUrl: "",
    legacyToken: ""
}));

/** Every value written back, in the order it was written — what the tests check their actions by. */
const saved = vi.hoisted(() => ({
    services: [] as TestService[][],
    defaultIds: [] as string[]
}));

// Only the three option hooks `ContentRelocationOptions` reads are replaced; `useStaticTooltip` (used
// by `ActionButton` and `Badge`) and the rest of the module stay real.
vi.mock("../../react/hooks", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../react/hooks")>()),
    useTriliumOptionBool: () => [
        options.enabled,
        (value: boolean) => { options.enabled = value; }
    ],
    useTriliumOptionJson: () => [
        options.services,
        (value: TestService[]) => { options.services = value; saved.services.push(value); }
    ],
    useTriliumOption: (name: string) => {
        if (name === "contentRelocationDefault") {
            return [
                options.defaultId,
                (value: string) => { options.defaultId = value; saved.defaultIds.push(value); }
            ];
        }
        if (name === "contentRelocationUrl") return [ options.legacyUrl, vi.fn() ];
        if (name === "contentRelocationToken") return [ options.legacyToken, vi.fn() ];
        return [ "", vi.fn() ];
    }
}));

import { ContentRelocationOptions } from "./database";

let container: HTMLDivElement;

async function renderComponent() {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => { render(<ContentRelocationOptions />, container); });
    return container;
}

/** Runs an interaction, then lets any promise chain it started (e.g. a confirm dialog) settle. */
async function interact(fn: () => void) {
    await act(async () => {
        fn();
        // Drains the microtask queue past `dialogService.confirm`'s own promise and the `await` in
        // the handler that reads it.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
}

/** The three plain-text inputs of the "add a service" form, in the order they are laid out. */
function addFormInputs() {
    return [ ...container.querySelectorAll<HTMLInputElement>("input:not([type='checkbox'])") ];
}

function type(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(name: string): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(`button[name='${name}']`);
}

beforeEach(() => {
    options.enabled = true;
    options.services = [];
    options.defaultId = "";
    options.legacyUrl = "";
    options.legacyToken = "";
    saved.services = [];
    saved.defaultIds = [];
    randomIds.nextIndex = 0;
    dialog.confirm.mockReset().mockResolvedValue(true);
});

afterEach(() => {
    render(null, container);
    container.remove();
});

describe("the configured services", () => {
    it("says nothing is configured while the list is empty and there is no address to carry over", async () => {
        await renderComponent();

        expect(container.textContent).toContain("content_relocation.no_services");
        expect(container.querySelector(".content-relocation-service-name")).toBeNull();
    });

    it("carries the address earlier versions stored in as a service of its own, already the default", async () => {
        options.legacyUrl = "http://127.0.0.1:37862/";
        options.legacyToken = "legacy-secret";
        await renderComponent();

        const rows = container.querySelectorAll(".content-relocation-service-name");
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain("default");
        // The sole entry already reads as the default, so it needs no button to become it.
        expect(container.querySelector("button.bx-star")).toBeNull();
        // The default badge marks it regardless, since `contentRelocationDefault` was never set.
        expect(container.textContent).toContain("content_relocation.default_badge");

        // The token is never shown, however it was carried in.
        expect(container.textContent).not.toContain("legacy-secret");
    });
});

describe("adding a service", () => {
    it("writes a new entry with a freshly generated id, and closes the form", async () => {
        await renderComponent();

        await interact(() => button("add-content-relocation-service-button")?.click());
        const [ name, url, token ] = addFormInputs();
        await interact(() => {
            type(name, "Home server");
            type(url, "http://192.168.1.10:37862/");
            type(token, "s3cr3t");
        });
        await interact(() => button("confirm-add-content-relocation-service-button")?.click());

        expect(saved.services.at(-1)).toEqual([
            { id: "generated-id-1", name: "Home server", url: "http://192.168.1.10:37862/", token: "s3cr3t" }
        ]);
        // The form collapses back into the "add" button once the service is written.
        expect(button("confirm-add-content-relocation-service-button")).toBeNull();
    });

    it("carries the legacy address into the list too, so the address is not silently dropped", async () => {
        options.legacyUrl = "http://127.0.0.1:37862/";
        await renderComponent();

        await interact(() => button("add-content-relocation-service-button")?.click());
        const [ name, url ] = addFormInputs();
        await interact(() => {
            type(name, "Second machine");
            type(url, "http://10.0.0.5:37862/");
        });
        await interact(() => button("confirm-add-content-relocation-service-button")?.click());

        expect(saved.services.at(-1)).toEqual([
            { id: "default", name: "default", url: "http://127.0.0.1:37862/", token: "" },
            { id: "generated-id-1", name: "Second machine", url: "http://10.0.0.5:37862/", token: "" }
        ]);
    });

    it("keeps a service's id stable across further additions", async () => {
        await renderComponent();

        await interact(() => button("add-content-relocation-service-button")?.click());
        let [ name, url ] = addFormInputs();
        await interact(() => {
            type(name, "First");
            type(url, "http://127.0.0.1:1/");
        });
        await interact(() => button("confirm-add-content-relocation-service-button")?.click());
        const firstWrite = saved.services.at(-1);
        expect(firstWrite?.[0].id).toBe("generated-id-1");

        await interact(() => button("add-content-relocation-service-button")?.click());
        [ name, url ] = addFormInputs();
        await interact(() => {
            type(name, "Second");
            type(url, "http://127.0.0.1:2/");
        });
        await interact(() => button("confirm-add-content-relocation-service-button")?.click());
        const secondWrite = saved.services.at(-1);

        // The first entry travels into the second write unchanged: nothing re-derives its id from
        // its name, which is free to be whatever the user typed.
        expect(secondWrite?.[0]).toEqual(firstWrite?.[0]);
        expect(secondWrite?.[1].id).toBe("generated-id-2");
    });

    it("refuses to add a service with no name or no address", async () => {
        await renderComponent();

        await interact(() => button("add-content-relocation-service-button")?.click());
        expect(button("confirm-add-content-relocation-service-button")?.disabled).toBe(true);

        const [ name ] = addFormInputs();
        await interact(() => type(name, "Only a name"));
        expect(button("confirm-add-content-relocation-service-button")?.disabled).toBe(true);
    });
});

describe("removing a service", () => {
    beforeEach(() => {
        options.services = [
            { id: "svc-a", name: "A", url: "http://a/", token: "" },
            { id: "svc-b", name: "B", url: "http://b/", token: "" }
        ];
        options.defaultId = "svc-a";
    });

    it("asks first, and leaves the list alone where the answer is no", async () => {
        dialog.confirm.mockResolvedValue(false);
        await renderComponent();

        await interact(() => container.querySelectorAll<HTMLButtonElement>("button.bx-trash")[0]?.click());

        expect(saved.services).toHaveLength(0);
    });

    it("hands the default on to what is left, once the default itself is removed", async () => {
        await renderComponent();

        // The first row is "A", the configured default.
        await interact(() => container.querySelectorAll<HTMLButtonElement>("button.bx-trash")[0]?.click());

        expect(saved.services.at(-1)).toEqual([ { id: "svc-b", name: "B", url: "http://b/", token: "" } ]);
        expect(saved.defaultIds.at(-1)).toBe("svc-b");
    });

    it("leaves the default alone when the service removed was not it", async () => {
        await renderComponent();

        // The second row is "B", not the default.
        await interact(() => container.querySelectorAll<HTMLButtonElement>("button.bx-trash")[1]?.click());

        expect(saved.services.at(-1)).toEqual([ { id: "svc-a", name: "A", url: "http://a/", token: "" } ]);
        expect(saved.defaultIds).toHaveLength(0);
    });
});

describe("choosing a default", () => {
    it("offers every service but the current default a way to become it", async () => {
        options.services = [
            { id: "svc-a", name: "A", url: "http://a/", token: "" },
            { id: "svc-b", name: "B", url: "http://b/", token: "" }
        ];
        options.defaultId = "svc-a";
        await renderComponent();

        expect(container.querySelectorAll("button.bx-star")).toHaveLength(1);

        await interact(() => container.querySelector<HTMLButtonElement>("button.bx-star")?.click());
        expect(saved.defaultIds.at(-1)).toBe("svc-b");
    });
});

describe("while relocation is switched off", () => {
    it("shows neither the list nor the way to add to it", async () => {
        options.enabled = false;
        options.services = [ { id: "svc-a", name: "A", url: "http://a/", token: "" } ];
        await renderComponent();

        expect(container.querySelector(".content-relocation-service-name")).toBeNull();
        expect(button("add-content-relocation-service-button")).toBeNull();
    });
});
