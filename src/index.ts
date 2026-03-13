import {
    getActiveTab,
    getAllTabs,
    Plugin,
    showMessage,
} from "siyuan";
import "./index.scss";

type TabLike = {
    id: string;
    headElement?: HTMLElement;
    parent?: WndLike;
    model?: {
        pin?: boolean;
        data?: {
            pin?: boolean;
        };
        tab?: {
            pin?: boolean;
        };
    };
    close?: (...args: unknown[]) => unknown;
    pin?: boolean | ((...args: unknown[]) => unknown);
    unpin?: (...args: unknown[]) => unknown;
    pinned?: boolean;
    isPinned?: boolean;
    [key: string]: unknown;
};

type WndLike = {
    children?: TabLike[];
    removeTab?: (...args: unknown[]) => unknown;
    [key: string]: unknown;
};

const PATCH_FLAG = "__safePinPatched__";
const SYNC_INTERVAL = 1000;
const NOTICE_INTERVAL = 1200;

export default class SafePinPlugin extends Plugin {
    private static activeInstance: SafePinPlugin | null = null;
    private readonly pinnedTabs = new WeakSet<TabLike>();
    private readonly restoreCallbacks: Array<() => void> = [];
    private readonly keydownHandler = this.handleKeydown.bind(this);
    private syncTimer = 0;
    private lastNoticeAt = 0;

    onload() {
        SafePinPlugin.activeInstance = this;
        this.startProtection();
        console.log(`[${this.name}] loaded`);
    }

    onunload() {
        SafePinPlugin.activeInstance = null;
        if (this.syncTimer) {
            window.clearInterval(this.syncTimer);
            this.syncTimer = 0;
        }
        document.removeEventListener("keydown", this.keydownHandler, true);
        this.restoreCallbacks.reverse().forEach((restore) => restore());
        this.restoreCallbacks.length = 0;
        console.log(`[${this.name}] unloaded`);
    }

    onLayoutReady() {
        this.startProtection();
    }

    private startProtection() {
        if (!this.syncTimer) {
            this.syncRuntimeHooks();
            this.syncTimer = window.setInterval(() => this.syncRuntimeHooks(), SYNC_INTERVAL);
        }
        document.removeEventListener("keydown", this.keydownHandler, true);
        document.addEventListener("keydown", this.keydownHandler, true);
    }

    private syncRuntimeHooks() {
        try {
            const tabs = getAllTabs() as TabLike[];
            tabs.forEach((tab) => {
                this.syncPinnedState(tab);
                this.patchTabPrototype(tab);
                if (tab.parent) {
                    this.patchWndPrototype(tab.parent);
                }
            });
        } catch (error) {
            console.error(`[${this.name}] failed to sync tab hooks`, error);
        }
    }

    private patchTabPrototype(tab: TabLike) {
        const prototype = Object.getPrototypeOf(tab) as Record<string, unknown>;
        if (!prototype || prototype[PATCH_FLAG]) {
            return;
        }
        prototype[PATCH_FLAG] = true;

        const originalClose = prototype.close as ((this: TabLike, ...args: unknown[]) => unknown) | undefined;
        const originalPin = prototype.pin as ((this: TabLike, ...args: unknown[]) => unknown) | undefined;
        const originalUnpin = prototype.unpin as ((this: TabLike, ...args: unknown[]) => unknown) | undefined;

        if (typeof originalClose === "function") {
            prototype.close = function (this: TabLike, ...args: unknown[]) {
                const plugin = SafePinPlugin.activeInstance;
                if ((window as unknown as {siyuan?: unknown}).siyuan && plugin?.isPinned(this)) {
                    plugin.notifyBlockedClose();
                    return;
                }
                return originalClose.apply(this, args);
            };
        }

        if (typeof originalPin === "function") {
            prototype.pin = function (this: TabLike, ...args: unknown[]) {
                const result = originalPin.apply(this, args);
                SafePinPlugin.activeInstance?.pinnedTabs.add(this);
                return result;
            };
        }

        if (typeof originalUnpin === "function") {
            prototype.unpin = function (this: TabLike, ...args: unknown[]) {
                const result = originalUnpin.apply(this, args);
                SafePinPlugin.activeInstance?.pinnedTabs.delete(this);
                return result;
            };
        }
        this.restoreCallbacks.push(() => {
            if (typeof originalClose === "function") {
                prototype.close = originalClose;
            }
            if (typeof originalPin === "function") {
                prototype.pin = originalPin;
            }
            if (typeof originalUnpin === "function") {
                prototype.unpin = originalUnpin;
            }
            delete prototype[PATCH_FLAG];
        });
    }

    private patchWndPrototype(wnd: WndLike) {
        const prototype = Object.getPrototypeOf(wnd) as Record<string, unknown>;
        if (!prototype || prototype[PATCH_FLAG]) {
            return;
        }
        prototype[PATCH_FLAG] = true;

        const originalRemoveTab = prototype.removeTab as ((this: WndLike, ...args: unknown[]) => unknown) | undefined;
        if (typeof originalRemoveTab === "function") {
            prototype.removeTab = function (this: WndLike, ...args: unknown[]) {
                const plugin = SafePinPlugin.activeInstance;
                const targetId = typeof args[0] === "string" ? args[0] : undefined;
                const targetTab = targetId ? this.children?.find((item) => item.id === targetId) : undefined;
                if (targetTab && plugin?.isPinned(targetTab)) {
                    plugin.notifyBlockedClose();
                    return;
                }
                return originalRemoveTab.apply(this, args);
            };
        }

        this.restoreCallbacks.push(() => {
            if (typeof originalRemoveTab === "function") {
                prototype.removeTab = originalRemoveTab;
            }
            delete prototype[PATCH_FLAG];
        });
    }

    private handleKeydown(event: KeyboardEvent) {
        const isCloseHotkey = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w";
        if (!isCloseHotkey) {
            return;
        }

        let activeTab: TabLike;
        try {
            activeTab = getActiveTab() as TabLike;
        } catch (error) {
            console.error(`[${this.name}] failed to get active tab`, error);
            return;
        }
        if (!activeTab || !this.isPinned(activeTab)) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        this.notifyBlockedClose();
    }

    private isPinned(tab: TabLike) {
        this.syncPinnedState(tab);
        return this.pinnedTabs.has(tab);
    }

    private syncPinnedState(tab: TabLike) {
        if (this.detectPinned(tab)) {
            this.pinnedTabs.add(tab);
        } else {
            this.pinnedTabs.delete(tab);
        }
    }

    private detectPinned(tab: TabLike) {
        if (!tab) {
            return false;
        }

        const pinCandidates = [
            tab.pinned,
            tab.isPinned,
            typeof tab.pin === "boolean" ? tab.pin : undefined,
            tab.model?.pin,
            tab.model?.data?.pin,
            tab.model?.tab?.pin,
            tab.headElement?.dataset.pin,
            tab.headElement?.getAttribute("data-pin"),
            tab.headElement?.getAttribute("data-pinned"),
            tab.headElement?.ariaLabel,
        ];

        if (pinCandidates.some((value) => this.isTruthyPinValue(value))) {
            return true;
        }

        const classNames = Array.from(tab.headElement?.classList ?? []);
        if (classNames.some((className) => /(^|[-_])pin(ned)?($|[-_])/i.test(className))) {
            return true;
        }

        try {
            const pinButton = tab.headElement?.querySelector("[data-type='pin']");
            if (pinButton) {
                return true;
            }
        } catch (error) {
            console.error(`[${this.name}] failed to inspect tab pin button`, error);
        }

        const ariaLabel = tab.headElement?.getAttribute("aria-label") || "";
        return /unpin|pinned|取消钉住|已钉住/i.test(ariaLabel);
    }

    private isTruthyPinValue(value: unknown) {
        if (value === true || value === 1 || value === "1") {
            return true;
        }
        if (typeof value !== "string") {
            return false;
        }
        const normalized = value.trim().toLowerCase();
        return normalized === "true" || normalized === "pin" || normalized === "pinned" || normalized === "yes";
    }

    private notifyBlockedClose() {
        const now = Date.now();
        if (now - this.lastNoticeAt < NOTICE_INTERVAL) {
            return;
        }
        this.lastNoticeAt = now;
        showMessage(this.i18n.blockedClose, 2000, "info");
    }
}
