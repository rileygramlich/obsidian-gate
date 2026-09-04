/**
 * First-run setup.
 *
 * Three steps, no jargon, and it does the work rather than telling the user
 * how to. Opens once on install; reachable afterwards from the settings screen
 * and the command palette.
 */
import { App, Modal, Notice, Setting } from "obsidian";
import type GatePlugin from "./main";
import {
  connectClient,
  detectClients,
  manualSnippet,
  type ClientState,
} from "./clients";
import type { Permission } from "./tools";

type Step = "access" | "connect" | "done";

export class SetupWizard extends Modal {
  private step: Step = "access";
  private connectedTo: string[] = [];

  constructor(
    app: App,
    private readonly plugin: GatePlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("vault-gate-wizard");
    this.renderStep();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
    if (this.plugin.settings.needsSetup) {
      // Dismissed early — don't nag on every restart.
      this.plugin.settings.needsSetup = false;
      await this.plugin.saveSettings();
    }
  }

  private renderStep(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (this.step === "access") this.renderAccess(contentEl);
    else if (this.step === "connect") this.renderConnect(contentEl);
    else this.renderDone(contentEl);
  }

  /* ------------------------------- step 1 ------------------------------ */

  private renderAccess(root: HTMLElement): void {
    root.createEl("h2", { text: "Let assistants use your vault" });
    root.createEl("p", {
      text:
        `Gate opens "${this.app.vault.getName()}" to AI assistants like Claude and Cursor. ` +
        "Everything stays on this computer — nothing is uploaded, and the connection only works while Obsidian is open.",
    });

    root.createEl("h3", { text: "What should they be allowed to do?" });

    const grant = (permission: Permission, name: string, desc: string) => {
      new Setting(root)
        .setName(name)
        .setDesc(desc)
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
    };

    grant("read", "Read my notes", "Open notes and follow links between them.");
    grant("search", "Search my notes", "Find notes by their text.");
    grant("write", "Create and edit notes", "Recommended off until you trust the assistant.");

    new Setting(root).addButton((btn) =>
      btn
        .setButtonText("Next")
        .setCta()
        .onClick(() => {
          this.step = "connect";
          this.renderStep();
        }),
    );
  }

  /* ------------------------------- step 2 ------------------------------ */

  private renderConnect(root: HTMLElement): void {
    root.createEl("h2", { text: "Connect an assistant" });

    const conn = this.plugin.connection();
    const installed = detectClients(conn).filter((s) => s.installed);

    if (installed.length) {
      root.createEl("p", {
        text: "Found these on your computer. Connecting adds Gate to the app's settings for you.",
      });
      for (const state of installed) this.renderConnectRow(root, state);
    } else {
      root.createEl("p", {
        text:
          "No supported assistants found. Copy the configuration below and paste it into your MCP client's settings file.",
      });
      new Setting(root).setName("Configuration").addButton((btn) =>
        btn.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(manualSnippet(conn));
          new Notice("Configuration copied.");
        }),
      );
    }

    new Setting(root)
      .addButton((btn) =>
        btn.setButtonText("Back").onClick(() => {
          this.step = "access";
          this.renderStep();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.connectedTo.length ? "Finish" : "Skip for now")
          .setCta()
          .onClick(() => {
            this.step = "done";
            this.renderStep();
          }),
      );
  }

  private renderConnectRow(root: HTMLElement, state: ClientState): void {
    const conn = this.plugin.connection();
    const setting = new Setting(root)
      .setName(state.definition.name)
      .setDesc(state.connected ? "Already connected." : (state.definition.note ?? ""));

    setting.addButton((btn) => {
      btn
        .setButtonText(state.connected ? "Reconnect" : "Connect")
        .onClick(async () => {
          const res = connectClient(state.definition, conn);
          if (res.ok && !this.connectedTo.includes(state.definition.name)) {
            this.connectedTo.push(state.definition.name);
          }
          new Notice(res.message, res.ok ? 6000 : 10000);
          if (!this.plugin.server.isRunning()) await this.plugin.startServer();
          this.renderStep();
        });
      if (!state.connected) btn.setCta();
    });
  }

  /* ------------------------------- step 3 ------------------------------ */

  private renderDone(root: HTMLElement): void {
    root.createEl("h2", { text: "You're set up" });

    if (this.connectedTo.length) {
      root.createEl("p", {
        text: `Restart ${this.connectedTo.join(" and ")} so the new connection is picked up, then try asking:`,
      });
    } else {
      root.createEl("p", {
        text: "Once an assistant is connected, try asking it:",
      });
    }

    const list = root.createEl("ul", { cls: "vault-gate-examples" });
    for (const example of [
      "What did I write about last week?",
      "Search my vault for notes on deployment.",
      "Summarise my meeting notes from this month.",
      ...(this.plugin.settings.permissions.includes("write")
        ? ["Save this conversation to my vault as a note."]
        : []),
    ]) {
      list.createEl("li", { text: example });
    }

    root.createEl("p", {
      cls: "setting-item-description",
      text: "The server runs only while Obsidian is open. You can change any of this later in Settings → Vault Gate.",
    });

    new Setting(root).addButton((btn) =>
      btn
        .setButtonText("Done")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.needsSetup = false;
          await this.plugin.saveSettings();
          if (this.plugin.settings.autoStart && !this.plugin.server.isRunning()) {
            await this.plugin.startServer();
          }
          this.close();
        }),
    );
  }
}
