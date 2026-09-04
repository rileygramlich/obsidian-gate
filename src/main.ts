/**
 * Vault Gate — an MCP server that runs inside Obsidian.
 *
 * Obsidian is already an Electron app holding an indexed copy of the vault, so
 * the server lives here rather than in a separate process the user has to
 * install and point at a folder. Turn the plugin on, click Connect, done.
 */
import { Notice, Plugin } from "obsidian";
import { manualSnippet } from "./clients";
import { GateServer, type ServerStatus } from "./server";
import { GateVault } from "./vault";
import type { ToolContext } from "./tools";
import {
  DEFAULT_SETTINGS,
  endpointUrl,
  normalizeSettings,
  type GateSettings,
} from "./settings";
import { GateSettingTab } from "./settings-tab";
import { SetupWizard } from "./wizard";

export interface ActivityEntry {
  ts: number;
  tool: string;
  summary: string;
  ok: boolean;
}

const MAX_ACTIVITY = 100;

export default class GatePlugin extends Plugin {
  settings: GateSettings = { ...DEFAULT_SETTINGS };
  server!: GateServer;
  vault!: GateVault;
  activity: ActivityEntry[] = [];

  private statusBar: HTMLElement | null = null;
  /** Set by the settings tab so it can repaint just the parts that changed. */
  onStatusChange: (() => void) | null = null;
  onActivityChange: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.vault = new GateVault(this.app, () => ({
      dailyNotesFolder: this.settings.dailyNotesFolder,
      frontmatterTemplate: this.settings.frontmatterTemplate,
      maxSearchResults: this.settings.maxSearchResults,
    }));

    this.server = new GateServer({
      port: this.settings.port,
      token: this.settings.token,
      context: () => this.toolContext(),
      onError: (err) => {
        new Notice(`Vault Gate: ${err.message}`, 8000);
        this.refreshStatus();
      },
    });

    this.addSettingTab(new GateSettingTab(this.app, this));

    this.addCommand({
      id: "toggle-server",
      name: "Start or stop the MCP server",
      callback: () => void this.toggleServer(),
    });
    this.addCommand({
      id: "copy-config",
      name: "Copy MCP configuration to clipboard",
      callback: () => void this.copyConfig(),
    });
    this.addCommand({
      id: "open-setup",
      name: "Open setup guide",
      callback: () => new SetupWizard(this.app, this).open(),
    });

    if (this.settings.showStatusBar) this.mountStatusBar();

    // Wait for layout: starting a listener during load slows Obsidian's start,
    // and the vault index isn't ready for tool calls yet anyway.
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.needsSetup) {
        new SetupWizard(this.app, this).open();
      } else if (this.settings.autoStart) {
        void this.startServer();
      }
    });
  }

  onunload(): void {
    // Obsidian does not await onunload, so this is fire-and-forget by design.
    // The listener is closed either way before the plugin's code goes away.
    void this.server?.stop();
  }

  /* ------------------------------ settings ----------------------------- */

  async loadSettings(): Promise<void> {
    const loaded = normalizeSettings(await this.loadData());
    this.settings = loaded;
    // normalizeSettings mints a token on first run; persist it so the config
    // we write into client files keeps working across restarts.
    await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.server.update({ port: this.settings.port, token: this.settings.token });
    if (this.settings.showStatusBar) this.mountStatusBar();
    else this.unmountStatusBar();
    // Status bar only: a save happens on every keystroke in a text field, and
    // notifying the settings tab here would rebuild the field being typed in.
    this.updateStatusBar();
  }

  /* ------------------------------- server ------------------------------ */

  private toolContext(): ToolContext {
    return {
      vault: this.vault,
      permissions: this.settings.permissions,
      onActivity: (entry) => this.record(entry),
    };
  }

  async startServer(): Promise<ServerStatus> {
    const status = await this.server.start();
    this.refreshStatus();
    return status;
  }

  async stopServer(): Promise<void> {
    await this.server.stop();
    this.refreshStatus();
  }

  async toggleServer(): Promise<void> {
    if (this.server.isRunning()) {
      await this.stopServer();
      new Notice("Vault Gate: server stopped.");
    } else {
      const status = await this.startServer();
      if (status.state === "running") {
        new Notice(`Vault Gate: listening on port ${status.port}.`);
      }
    }
  }

  /** Restart in place — the only way a port change can take effect. */
  async restartServer(): Promise<void> {
    if (!this.server.isRunning() && this.server.getStatus().state !== "error") return;
    await this.server.stop();
    await this.startServer();
  }

  async copyConfig(): Promise<void> {
    await navigator.clipboard.writeText(manualSnippet(this.connection()));
    new Notice("Vault Gate: configuration copied to clipboard.");
  }

  connection() {
    return {
      serverName: this.settings.serverName,
      url: endpointUrl(this.settings),
      token: this.settings.token,
    };
  }

  /* ------------------------------ activity ----------------------------- */

  private record(entry: { tool: string; summary: string; ok: boolean }): void {
    this.activity.unshift({ ts: Date.now(), ...entry });
    if (this.activity.length > MAX_ACTIVITY) this.activity.length = MAX_ACTIVITY;
    this.onActivityChange?.();
  }

  /* ----------------------------- status bar ---------------------------- */

  private mountStatusBar(): void {
    if (this.statusBar) return;
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("vault-gate-status");
    this.registerDomEvent(this.statusBar, "click", () => void this.toggleServer());
    this.updateStatusBar();
  }

  private unmountStatusBar(): void {
    this.statusBar?.remove();
    this.statusBar = null;
  }

  /** Server state changed: repaint the status bar and let the settings tab know. */
  refreshStatus(): void {
    this.updateStatusBar();
    this.onStatusChange?.();
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;

    const status = this.server.getStatus();
    this.statusBar.empty();
    this.statusBar.removeClass("is-running", "is-error");

    const dot = this.statusBar.createSpan({ cls: "vault-gate-dot" });
    const label = this.statusBar.createSpan();

    if (status.state === "running") {
      this.statusBar.addClass("is-running");
      label.setText(`Gate :${status.port}`);
      this.statusBar.setAttribute("aria-label", "Vault Gate is running — click to stop");
    } else if (status.state === "error") {
      this.statusBar.addClass("is-error");
      label.setText("Gate error");
      this.statusBar.setAttribute("aria-label", status.message);
    } else {
      label.setText("Gate off");
      this.statusBar.setAttribute("aria-label", "Vault Gate is stopped — click to start");
    }
    dot.setAttribute("aria-hidden", "true");
  }
}
