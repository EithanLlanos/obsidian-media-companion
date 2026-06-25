import { App, Modal, Setting, AbstractInputSuggest, TextComponent, DropdownComponent, TextAreaComponent } from "obsidian";
import type { TFile } from "obsidian";

interface LayoutItem {
	mediaFile: TFile;
	sidecarFile: TFile | null;
}

interface PropertyRowState {
	name: string;
	originalName: string;
	value: string;
	action: "Ignore" | "Replace" | "Append" | "Remove";
	isMixed: boolean;
	isNew: boolean;
	type: string;
}

class TokenInput {
	containerEl: HTMLElement;
	inputEl: HTMLInputElement;
	values: string[];
	onChangeCallback: (values: string[]) => void;

	constructor(parentEl: HTMLElement, initialValue: string) {
		this.containerEl = parentEl.createDiv("mc-token-container");
		this.values = initialValue ? initialValue.split(/[,\n]/).map(s => s.trim()).filter(s => s.length > 0) : [];
		
		this.inputEl = this.containerEl.createEl("input", { cls: "mc-token-input" });
		this.inputEl.type = "text";
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.addToken();
			} else if (e.key === "Backspace" && this.inputEl.value === "" && this.values.length > 0) {
				this.values.pop();
				this.renderTokens();
				this.onChangeCallback?.(this.values);
			}
		});

		this.renderTokens();
	}

	renderTokens() {
		this.containerEl.querySelectorAll(".mc-token-pill").forEach(el => el.remove());

		for (const val of this.values) {
			const pill = document.createElement("div");
			pill.className = "mc-token-pill";
			pill.createSpan({ text: val });
			const close = pill.createSpan({ text: "x", cls: "mc-token-pill-close" });
			close.addEventListener("click", () => {
				const idx = this.values.indexOf(val);
				if (idx > -1) {
					this.values.splice(idx, 1);
					this.renderTokens();
					this.onChangeCallback?.(this.values);
				}
			});
			this.containerEl.insertBefore(pill, this.inputEl);
		}
	}

	addToken() {
		const val = this.inputEl.value.trim();
		if (val) {
			this.values.push(val);
			this.inputEl.value = "";
			this.renderTokens();
			this.onChangeCallback?.(this.values);
		}
	}

	onChange(cb: (values: string[]) => void): this {
		this.onChangeCallback = cb;
		return this;
	}

	setPlaceholder(placeholder: string) {
		this.inputEl.placeholder = placeholder;
		return this;
	}
}


export class BulkEditModal extends Modal {
	private selectedItems: LayoutItem[];
	private rows: PropertyRowState[] = [];

	constructor(app: App, selectedItems: LayoutItem[]) {
		super(app);
		this.selectedItems = selectedItems;
	}

	onOpen() {
		this.aggregateProperties();
		this.renderUI();
	}

	private aggregateProperties() {
		const uniqueProps = new Map<string, { values: Set<string>, rawValues: any[] }>();

		for (const item of this.selectedItems) {
			const file = item.sidecarFile || item.mediaFile;
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter) {
				for (const [key, val] of Object.entries(cache.frontmatter)) {
					if (key === "position") continue;
					if (!uniqueProps.has(key)) {
						uniqueProps.set(key, { values: new Set(), rawValues: [] });
					}
					const strVal = typeof val === "object" ? JSON.stringify(val) : String(val);
					uniqueProps.get(key)!.values.add(strVal);
					uniqueProps.get(key)!.rawValues.push(val);
				}
			}
		}

		this.rows = [];
		const typeManager = (this.app as any).metadataTypeManager;

		for (const [key, data] of uniqueProps.entries()) {
			const isMixed = data.values.size > 1 || data.rawValues.length < this.selectedItems.length;
			let initialValue = "";
			if (!isMixed && data.rawValues.length > 0) {
				const val = data.rawValues[0];
				if (Array.isArray(val)) {
					initialValue = val.join(", ");
				} else {
					initialValue = String(val);
				}
			}

			let currentType = typeManager?.getAssignedType?.(key)?.type || typeManager?.getProperties?.()?.[key]?.type || "text";

			this.rows.push({
				name: key,
				originalName: key,
				value: initialValue,
				action: "Ignore",
				isMixed,
				isNew: false,
				type: currentType
			});
		}
	}

	private renderUI() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("bulk-properties-manager");

		contentEl.createEl("h2", { text: `Bulk Properties Manager (${this.selectedItems.length} items)` });

		const container = contentEl.createDiv("bulk-edit-container");
		container.style.maxHeight = "400px";
		container.style.overflowY = "auto";
		container.style.paddingRight = "10px";

		this.rows.forEach(row => this.renderRow(container, row));

		const addBtnContainer = contentEl.createDiv();
		addBtnContainer.style.marginTop = "10px";

		new Setting(addBtnContainer)
			.addButton(btn => btn
				.setButtonText("+ Add Property")
				.onClick(() => {
					this.rows.push({
						name: "",
						originalName: "",
						value: "",
						action: "Replace",
						isMixed: false,
						isNew: true,
						type: "text"
					});
					this.renderUI();
				})
			);

		const actionsContainer = contentEl.createDiv();
		actionsContainer.style.marginTop = "20px";
		actionsContainer.style.borderTop = "1px solid var(--background-modifier-border)";
		actionsContainer.style.paddingTop = "10px";

		new Setting(actionsContainer)
			.addButton(btn => btn
				.setButtonText("Apply")
				.setCta()
				.onClick(async () => {
					await this.applyBulkEdit();
					this.close();
				})
			);
	}

	private renderRow(container: HTMLElement, row: PropertyRowState) {
		const rowEl = container.createDiv("bulk-edit-row");
		rowEl.style.display = "flex";
		rowEl.style.alignItems = "center";
		rowEl.style.gap = "10px";
		rowEl.style.marginBottom = "10px";

		// Property Name
		if (row.isNew) {
			const nameInput = new TextComponent(rowEl)
				.setPlaceholder("Property name")
				.setValue(row.name)
				.onChange(v => {
					row.name = v;
				});
			nameInput.inputEl.style.width = "120px";
			new PropertySuggest(this.app, nameInput.inputEl, this.selectedItems);
		} else {
			const nameSpan = rowEl.createSpan({ text: row.name, cls: "bulk-edit-prop-name" });
			nameSpan.style.width = "120px";
			nameSpan.style.overflow = "hidden";
			nameSpan.style.textOverflow = "ellipsis";
			nameSpan.style.whiteSpace = "nowrap";
			nameSpan.title = row.name;
		}

		// Global Type Dropdown
		const typeOptions: Record<string, string> = {
			"text": "Text",
			"multitext": "List",
			"number": "Number",
			"checkbox": "Checkbox",
			"date": "Date",
			"datetime": "Date & time",
			"aliases": "Aliases",
			"tags": "Tags"
		};

		let currentType = row.type;
		if (!typeOptions[currentType]) currentType = "text";

		const typeDropdown = new DropdownComponent(rowEl)
			.addOptions(typeOptions)
			.setValue(currentType)
			.onChange(v => {
				row.type = v;
				if (row.name) {
					const typeManager = (this.app as any).metadataTypeManager;
					typeManager?.setType?.(row.name, v);
				}
				this.updateActionOptions(actionDropdown, row);
			});
		typeDropdown.selectEl.style.width = "110px";

		// Action Dropdown
		const actionDropdown = new DropdownComponent(rowEl);
		this.updateActionOptions(actionDropdown, row);
		actionDropdown.onChange(v => {
			row.action = v as any;
		});

		let valueInputEl: HTMLInputElement | HTMLTextAreaElement;
		
		if (["multitext", "tags", "aliases"].includes(row.type)) {
			const valueInput = new TokenInput(rowEl, row.value)
				.onChange(values => {
					row.value = values.join(", ");
					if (row.action === "Ignore") {
						row.action = "Replace";
						actionDropdown.setValue("Replace");
					}
				});
			valueInput.containerEl.style.flex = "1";

			if (row.isMixed && !row.value) {
				valueInput.setPlaceholder("(Mixed values)");
			} else {
				valueInput.setPlaceholder("Value");
			}
			valueInputEl = valueInput.inputEl;
		} else {
			const valueInput = new TextAreaComponent(rowEl)
				.setValue(row.value)
				.onChange(v => {
					row.value = v;
					if (row.action === "Ignore") {
						row.action = "Replace";
						actionDropdown.setValue("Replace");
					}
				});
			valueInput.inputEl.rows = 1;
			valueInput.inputEl.style.flex = "1";
			valueInput.inputEl.style.resize = "vertical";
			valueInput.inputEl.style.minHeight = "30px";

			if (row.isMixed && !row.value) {
				valueInput.setPlaceholder("(Mixed values)");
			} else {
				valueInput.setPlaceholder("Value");
			}
			valueInputEl = valueInput.inputEl;
		}

		new ValueSuggest(this.app, valueInputEl, () => row.name);
	}

	private updateActionOptions(dropdown: DropdownComponent, row: PropertyRowState) {
		dropdown.selectEl.empty();
		dropdown.addOption("Ignore", "Ignore");
		dropdown.addOption("Replace", "Replace");
		if (["multitext", "tags", "aliases"].includes(row.type)) {
			dropdown.addOption("Append", "Append");
		}
		dropdown.addOption("Remove", "Remove");
		
		if (row.action === "Append" && !["multitext", "tags", "aliases"].includes(row.type)) {
			row.action = "Replace";
		}
		dropdown.setValue(row.action);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	private async applyBulkEdit() {
		const activeRows = this.rows.filter(r => r.name && r.action !== "Ignore");
		if (activeRows.length === 0) return;

		for (const item of this.selectedItems) {
			const file = item.sidecarFile || item.mediaFile;
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				for (const row of activeRows) {
					if (row.action === "Remove") {
						delete frontmatter[row.name];
						continue;
					}

					const parsed = this.parseValue(row.value, row.type);

					if (row.action === "Replace") {
						frontmatter[row.name] = parsed;
					} else if (row.action === "Append") {
						const current = frontmatter[row.name];
						if (Array.isArray(current)) {
							if (Array.isArray(parsed)) {
								frontmatter[row.name] = [...current, ...parsed];
							} else {
								frontmatter[row.name] = [...current, parsed];
							}
						} else if (current !== undefined && current !== null) {
							if (Array.isArray(parsed)) {
								frontmatter[row.name] = [current, ...parsed];
							} else {
								frontmatter[row.name] = [current, parsed];
							}
						} else {
							frontmatter[row.name] = parsed;
						}

						if (["tags", "aliases", "multitext"].includes(row.type)) {
							if (Array.isArray(frontmatter[row.name])) {
								frontmatter[row.name] = [...new Set(frontmatter[row.name])];
							}
						}
					}
				}
			});
		}
	}

	private parseValue(val: string, type: string): any {
		if (["multitext", "tags", "aliases"].includes(type)) {
			return val.split(/[,\n]/).map(s => s.trim()).filter(s => s.length > 0);
		}
		if (type === "number") {
			const n = Number(val);
			return isNaN(n) ? val : n;
		}
		if (type === "checkbox") {
			const lower = val.toLowerCase().trim();
			return lower === "true" || lower === "1" || lower === "yes";
		}
		return val;
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
		
		if (this.textInputEl.classList.contains("mc-token-input")) {
			const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
			this.textInputEl.dispatchEvent(enterEvent);
		}
		
		this.close();
	}
}
