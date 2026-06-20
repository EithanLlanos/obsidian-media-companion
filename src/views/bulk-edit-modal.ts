import { App, Modal, Setting, AbstractInputSuggest } from "obsidian";
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
			.addText(text => {
				text.setPlaceholder("e.g. tags")
					.onChange(value => {
						this.propName = value;
					});
				new PropertySuggest(this.app, text.inputEl, this.selectedItems);
			});

		new Setting(contentEl)
			.setName("New Value")
			.setDesc("The value to set for the property")
			.addTextArea(text => {
				text.setPlaceholder("e.g. #landscape")
					.onChange(value => {
						this.propValue = value;
					});
				text.inputEl.rows = 4;
				new ValueSuggest(this.app, text.inputEl, () => this.propName);
			});

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

class PropertySuggest extends AbstractInputSuggest<string> {
	app: App;
	textInputEl: HTMLInputElement | HTMLTextAreaElement;
	selectedItems: LayoutItem[];

	constructor(app: App, textInputEl: HTMLInputElement | HTMLTextAreaElement, selectedItems: LayoutItem[]) {
		super(app, textInputEl as any);
		this.app = app;
		this.textInputEl = textInputEl;
		this.selectedItems = selectedItems;
	}

	getSuggestions(inputStr: string): string[] {
		const lowerInput = inputStr.toLowerCase();
		const suggestions = new Set<string>();
		suggestions.add("tags");
		suggestions.add("aliases");
		
		for (const item of this.selectedItems) {
			const file = item.sidecarFile || item.mediaFile;
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter) {
				for (const key of Object.keys(cache.frontmatter)) {
					suggestions.add(key);
				}
			}
		}

		return Array.from(suggestions).filter(s => s.toLowerCase().includes(lowerInput));
	}

	renderSuggestion(suggestion: string, el: HTMLElement): void {
		el.setText(suggestion);
	}

	selectSuggestion(suggestion: string): void {
		this.textInputEl.value = suggestion;
		const event = new Event('input', { bubbles: true });
		this.textInputEl.dispatchEvent(event);
		this.close();
	}
}

class ValueSuggest extends AbstractInputSuggest<string> {
	app: App;
	textInputEl: HTMLInputElement | HTMLTextAreaElement;
	getPropName: () => string;

	constructor(app: App, textInputEl: HTMLInputElement | HTMLTextAreaElement, getPropName: () => string) {
		super(app, textInputEl as any);
		this.app = app;
		this.textInputEl = textInputEl;
		this.getPropName = getPropName;
	}

	getSuggestions(inputStr: string): string[] {
		const propName = this.getPropName().toLowerCase();
		
		const cursorPosition = (this.textInputEl as HTMLInputElement | HTMLTextAreaElement).selectionStart || 0;
		const textBeforeCursor = inputStr.substring(0, cursorPosition);
		
		let searchStr = "";
		let match = false;

		const hashMatch = textBeforeCursor.match(/#([^\s]*)$/);
		if (hashMatch) {
			searchStr = "#" + hashMatch[1];
			match = true;
		} else if (propName === "tags") {
			const tagMatch = textBeforeCursor.match(/([^,\s]+)$/);
			if (tagMatch) {
				searchStr = "#" + tagMatch[1];
			} else {
				searchStr = "#";
			}
			match = true;
		}

		if (!match) return [];

		const searchLower = searchStr.toLowerCase();
		const tags = Object.keys(this.app.metadataCache.getTags());
		return tags.filter(tag => tag.toLowerCase().includes(searchLower)).slice(0, 20);
	}

	renderSuggestion(suggestion: string, el: HTMLElement): void {
		el.setText(suggestion);
	}

	selectSuggestion(suggestion: string): void {
		const propName = this.getPropName().toLowerCase();
		const currentValue = this.textInputEl.value;
		const cursorPosition = (this.textInputEl as HTMLInputElement | HTMLTextAreaElement).selectionStart || 0;
		const textBeforeCursor = currentValue.substring(0, cursorPosition);
		const textAfterCursor = currentValue.substring(cursorPosition);
		
		let newValue = currentValue;
		
		const hashMatch = textBeforeCursor.match(/#([^\s]*)$/);
		if (hashMatch) {
			const startIdx = textBeforeCursor.lastIndexOf("#");
			newValue = textBeforeCursor.substring(0, startIdx) + suggestion + textAfterCursor;
		} else if (propName === "tags") {
			const tagMatch = textBeforeCursor.match(/([^,\s]*)$/);
			if (tagMatch) {
				const startIdx = textBeforeCursor.length - tagMatch[1].length;
				const cleanSuggestion = suggestion.startsWith("#") ? suggestion.substring(1) : suggestion;
				newValue = textBeforeCursor.substring(0, startIdx) + cleanSuggestion + textAfterCursor;
			}
		}

		this.textInputEl.value = newValue;
		const event = new Event('input', { bubbles: true });
		this.textInputEl.dispatchEvent(event);
		this.close();
	}
}
