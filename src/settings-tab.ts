/**
 * The settings screen.
 *
 * This is the whole product surface for most users, so it is organised around
 * what they came to do — turn it on, connect an assistant — rather than around
 * the settings object. Everything below "Connect" is tuning they can ignore.
 *
 * Sections repaint independently. A full rebuild on every change would tear
 * down the text field the user is currently typing into, since Obsidian fires
 * onChange per keystroke.
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GatePlugin from "./main";
import {
  connectClient,
  detectClients,
  disconnectClient,
  manualSnippet,
  type ClientState,
} from "./clients";
import { generateToken } from "./settings";
import type { Permission } from "./tools";
import { SetupWizard } from "./wizard";

const PERMISSION_LABELS: Record<Permission, { name: string; desc: string }> = {
  read: { name: "Read notes", desc: "List folders, open notes, follow backlinks and tags." },
  search: { name: "Search", desc: "Full-text search across the whole vault." },
  write: {
    name: "Write notes",
    desc: "Create notes, edit existing ones, and add links. Grant this only to assistants you trust.",
  },
};

export class GateSettingTab extends PluginSettingTab {
  private statusEl: HTMLElement | null = null;
  private clientsEl: HTMLElement | null = null;
  private activityEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: GatePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("vault-gate-settings");

    this.statusEl = containerEl.createDiv();
    this.renderStatus();

    new Setting(containerEl).setName("Connect an assistant").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Gate writes the connection into each app's own settings file, and keeps a .gate-backup copy next to it. " +
        "Restart the app afterwards for it to notice.",
    });
    this.clientsEl = containerEl.createDiv();
    this.renderClients();

    this.renderAccess(containerEl);
    this.renderServer(containerEl);
    this.renderVault(containerEl);

    new Setting(containerEl).setName("Recent activity").setHeading();
    this.activityEl = containerEl.createDiv();
    this.renderActivity();

    this.plugin.onStatusChange = () => {
      this.renderStatus();
      this.renderClients();
    };
    this.plugin.onActivityChange = () => this.renderActivity();
  }

  hide(): void {
    this.plugin.onStatusChange = null;
    this.plugin.onActivityChange = null;
    this.statusEl = this.clientsEl = this.activityEl = null;
  }

  /* ------------------------------- status ------------------------------ */

  private renderStatus(): void {
    const root = this.statusEl;
    if (!root) return;
    root.empty();

    const status = this.plugin.server.getStatus();
    const running = status.state === "running";

    const card = root.createDiv({ cls: "vault-gate-card" });
    const head = card.createDiv({ cls: "vault-gate-card-head" });

    const badge = head.createDiv({ cls: "vault-gate-badge" });
    badge.toggleClass("is-running", running);
    badge.toggleClass("is-error", status.state === "error");
    badge.createSpan({ cls: "vault-gate-dot" });
    badge.createSpan({
      text: running ? "Running" : status.state === "error" ? "Error" : "Stopped",
    });

    const text = head.createDiv({ cls: "vault-gate-card-text" });
    text.createEl("h3", { text: "Vault Gate" });
    text.createEl("p", {
      text: running
        ? `Assistants can reach "${this.app.vault.getName()}" at ${this.plugin.connection().url}`
        : status.state === "error"
          ? status.message
          : "The server is off. Assistants cannot reach your vault.",
    });

    const actions = card.createDiv({ cls: "vault-gate-card-actions" });

    const toggle = actions.createEl("button", {
      text: running ? "Stop server" : "Start server",
      cls: running ? "" : "mod-cta",
    });
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      await this.plugin.toggleServer();
      this.renderStatus();
    });

    const guide = actions.createEl("button", { text: "Setup guide" });
    guide.addEventListener("click", () => new SetupWizard(this.app, this.plugin).open());
  }

  /* ------------------------------ clients ------------------------------ */

  private renderClients(): void {
    const root = this.clientsEl;
    if (!root) return;
    root.empty();

    const conn = this.plugin.connection();
    const states = detectClients(conn);
    const installed = states.filter((s) => s.installed);
    const missing = states.filter((s) => !s.installed);

    for (const state of installed) this.renderClientRow(root, state);

    if (!installed.length) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: "No supported assistants found on this computer. Use “Copy configuration” below to set one up by hand.",
      });
    }

    if (missing.length) {
      const details = root.createEl("details", { cls: "vault-gate-details" });
      details.createEl("summary", { text: `Not installed (${missing.length})` });
      for (const state of missing) this.renderClientRow(details, state, true);
    }

    new Setting(root)
      .setName("Copy configuration")
      .setDesc("For any other MCP client — paste this into its config file.")
      .addButton((btn) =>
        btn.setButtonText("Copy JSON").onClick(async () => {
          await navigator.clipboard.writeText(manualSnippet(conn));
          new Notice("Configuration copied.");
        }),
      );
  }

  private renderClientRow(root: HTMLElement, state: ClientState, dimmed = false): void {
    const conn = this.plugin.connection();
    const setting = new Setting(root).setName(state.definition.name);

    const parts: string[] = [];
    if (state.connected) parts.push("Connected.");
    if (state.definition.note) parts.push(state.definition.note);
    if (state.configPath) parts.push(state.configPath);
    setting.setDesc(parts.join(" "));
    if (dimmed) setting.settingEl.addClass("vault-gate-dim");

    if (state.connected) {
      setting.addButton((btn) =>
        btn.setButtonText("Disconnect").onClick(() => {
          const res = disconnectClient(state.definition, conn);
          new Notice(res.message);
          this.renderClients();
        }),
      );
    }

    setting.addButton((btn) => {
      btn.setButtonText(state.connected ? "Reconnect" : "Connect").onClick(async () => {
        const res = connectClient(state.definition, conn);
        new Notice(res.message, res.ok ? 6000 : 10000);
        if (res.ok && !this.plugin.server.isRunning()) {
          await this.plugin.startServer();
          this.renderStatus();
        }
        this.renderClients();
      });
      if (!state.connected) btn.setCta();
    });
  }

  /* ------------------------------- access ------------------------------ */

  private renderAccess(root: HTMLElement): void {
    new Setting(root).setName("What assistants may do").setHeading();

    for (const permission of ["read", "search", "write"] as Permission[]) {
      const label = PERMISSION_LABELS[permission];
      new Setting(root)
        .setName(label.name)
        .setDesc(label.desc)
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.permissions.includes(permission))
            .onChange(async (value) => {
              const set = new Set(this.plugin.settings.permissions);
              if (value) set.add(permission);
              else set.delete(permission);
              this.plugin.settings.permissions = Array.from(set);
              await this.plugin.saveSettings();
            }),
        );
    }
  }

  /* ------------------------------- server ------------------------------ */

  private renderServer(root: HTMLElement): void {
    new Setting(root).setName("Server").setHeading();

    new Setting(root)
      .setName("Start automatically")
      .setDesc("Run the server whenever Obsidian is open.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
          this.plugin.settings.autoStart = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(root)
      .setName("Port")
      .setDesc("Only 127.0.0.1 can reach it. Change this if something else already uses the port.")
      .addText((text) =>
        text
          .setPlaceholder("22360")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const port = Number(value);
            if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
            this.plugin.settings.port = port;
            await this.plugin.saveSettings();
            await this.plugin.restartServer();
          }),
      );

    new Setting(root)
      .setName("Name in assistant configs")
      .setDesc('The key agents see this server under. "obsidian" reads well in a tool list.')
      .addText((text) =>
        text
          .setPlaceholder("obsidian")
          .setValue(this.plugin.settings.serverName)
          .onChange(async (value) => {
            const name = value.trim();
            if (!name) return;
            this.plugin.settings.serverName = name;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName("Access token")
      .setDesc(
        "Every request must present this. Regenerating it disconnects assistants until you reconnect them.",
      )
      .addButton((btn) =>
        btn.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.settings.token);
          new Notice("Token copied.");
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Regenerate")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.token = generateToken();
            await this.plugin.saveSettings();
            await this.plugin.restartServer();
            new Notice("New token generated. Reconnect your assistants.");
            this.renderClients();
          }),
      );

    new Setting(root)
      .setName("Show in status bar")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showStatusBar).onChange(async (value) => {
          this.plugin.settings.showStatusBar = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  /* -------------------------------- vault ------------------------------ */

  private renderVault(root: HTMLElement): void {
    new Setting(root).setName("Notes").setHeading();

    new Setting(root)
      .setName("Daily notes folder")
      .setDesc("Where get_daily_note looks. Leave empty for the vault root.")
      .addText((text) =>
        text
          .setPlaceholder("Journal")
          .setValue(this.plugin.settings.dailyNotesFolder)
          .onChange(async (value) => {
            this.plugin.settings.dailyNotesFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName("Search results")
      .setDesc("Most notes a single search may return.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxSearchResults)).onChange(async (value) => {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1 || n > 500) return;
          this.plugin.settings.maxSearchResults = n;
          await this.plugin.saveSettings();
        }),
      );
  }

  /* ------------------------------ activity ----------------------------- */

  private renderActivity(): void {
    const root = this.activityEl;
    if (!root) return;
    root.empty();

    const entries = this.plugin.activity.slice(0, 15);
    if (!entries.length) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: "Nothing yet. Calls from your assistants show up here.",
      });
      return;
    }

    const list = root.createEl("ul", { cls: "vault-gate-activity" });
    for (const entry of entries) {
      const item = list.createEl("li");
      item.toggleClass("is-error", !entry.ok);
      item.createSpan({
        cls: "vault-gate-activity-time",
        text: new Date(entry.ts).toLocaleTimeString(),
      });
      item.createSpan({ cls: "vault-gate-activity-tool", text: entry.tool });
      item.createSpan({ cls: "vault-gate-activity-summary", text: entry.summary });
    }
  }
}
