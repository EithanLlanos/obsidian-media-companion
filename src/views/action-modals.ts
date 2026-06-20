import { App, Modal, Setting, TFile, TFolder, FuzzySuggestModal } from "obsidian";

export class RenameModal extends Modal {
	private mediaFile: TFile;
	private sidecarFile: TFile | null;
	private newName: string;

	constructor(app: App, mediaFile: TFile, sidecarFile: TFile | null) {
		super(app);
		this.mediaFile = mediaFile;
		this.sidecarFile = sidecarFile;
		this.newName = mediaFile.basename;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Rename Media" });

		new Setting(contentEl)
			.setName("New name")
			.addText(text => text
				.setValue(this.newName)
				.onChange(value => {
					this.newName = value;
				}));

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText("Rename")
				.setCta()
				.onClick(async () => {
					if (!this.newName || this.newName === this.mediaFile.basename) {
						this.close();
						return;
					}

					const parentPath = this.mediaFile.parent && this.mediaFile.parent.path !== "/" 
						? this.mediaFile.parent.path + "/" 
						: "";
					const newMediaPath = `${parentPath}${this.newName}.${this.mediaFile.extension}`;
					
					await this.app.fileManager.renameFile(this.mediaFile, newMediaPath);

					if (this.sidecarFile) {
						const newSidecarPath = `${newMediaPath}.sidecar.md`;
						await this.app.fileManager.renameFile(this.sidecarFile, newSidecarPath);
					}
					this.close();
				}));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class MoveModal extends FuzzySuggestModal<TFolder> {
	private mediaFile: TFile;
	private sidecarFile: TFile | null;

	constructor(app: App, mediaFile: TFile, sidecarFile: TFile | null) {
		super(app);
		this.mediaFile = mediaFile;
		this.sidecarFile = sidecarFile;
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		const allFiles = this.app.vault.getAllLoadedFiles();
		for (const file of allFiles) {
			if (file instanceof TFolder) {
				folders.push(file);
			}
		}
		return folders;
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	async onChooseItem(folder: TFolder, evt: MouseEvent | KeyboardEvent) {
		const newMediaPath = folder.path === "/" ? this.mediaFile.name : `${folder.path}/${this.mediaFile.name}`;
		await this.app.fileManager.renameFile(this.mediaFile, newMediaPath);

		if (this.sidecarFile) {
			const newSidecarPath = folder.path === "/" ? this.sidecarFile.name : `${folder.path}/${this.sidecarFile.name}`;
			await this.app.fileManager.renameFile(this.sidecarFile, newSidecarPath);
		}
	}
}
