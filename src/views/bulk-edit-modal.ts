import { App, Modal, Setting } from "obsidian";
import type { TFile } from "obsidian";

interface LayoutItem {
	mediaFile: TFile;
	sidecarFile: TFile | null;
}

export class BulkEditModal extends Modal {
	private selectedItems: LayoutItem[];
	private propName: string = "";
	private propValue: string = "";

	constructor(app: App, selectedItems: LayoutItem[]) {
		super(app);
		this.selectedItems = selectedItems;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: `Bulk Edit (${this.selectedItems.length} items)` });

		new Setting(contentEl)
			.setName("Property Name")
			.setDesc("The frontmatter property to update or add")
			.addText(text => text
				.setPlaceholder("e.g. tags")
				.onChange(value => {
					this.propName = value;
				})
			);

		new Setting(contentEl)
			.setName("New Value")
			.setDesc("The value to set for the property")
			.addText(text => text
				.setPlaceholder("e.g. #landscape")
				.onChange(value => {
					this.propValue = value;
				})
			);

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText("Apply")
				.setCta()
				.onClick(() => {
					this.applyBulkEdit();
					this.close();
				})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	private async applyBulkEdit() {
		if (!this.propName) return;
		for (const item of this.selectedItems) {
			const file = item.sidecarFile || item.mediaFile;
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				frontmatter[this.propName] = this.propValue;
			});
		}
	}
}
