import { BasesView, Keymap, Menu, Notice, parsePropertyId, TFolder, setIcon, type BasesPropertyId, type QueryController, type HoverParent, type HoverPopover, type TFile, type BasesEntry, type WorkspaceLeaf } from "obsidian";
import Sidecar from "../model/sidecar";
import { getMediaType, MediaTypes } from "../model/types/mediaTypes";
import { getShape } from "../model/types/shape";
import { hexToRgb, rgbToHsl, isColorWithinThreshold, isGrayscale } from "../util/color";
import { VIEW_TYPE_SIDECAR } from "./sidecar-view";
import type { MediaCompanionSettings } from "../settings";
import { BulkEditModal } from "./bulk-edit-modal";
import { RenameModal, MoveModal } from "./action-modals";
import { extractColors } from "extract-colors";

export const BASES_VIEW_TYPE_WATERFALL = "mc-waterfall";

const LABEL_HEIGHT = 24;
const BUFFER_PX = 800;
const PADDING = 8;

interface LayoutItem {
	mediaFile: TFile;
	sidecarFile: TFile | null;
	entry: BasesEntry | null;
	metaWidth: number;
	metaHeight: number;
	colors: { h: number; s: number; l: number; area: number }[] | null;

	col: number;
	x: number;
	y: number;

	itemHeight: number;
	measured: boolean;
	propsMeasured: boolean;
	propsHeight: number;
	el: HTMLElement | null;
	selected?: boolean;
}

/**
 * A Bases view that renders media in a waterfall (masonry) layout using
 * absolute positioning with virtual scrolling.
 */
export class WaterfallBasesView extends BasesView implements HoverParent {
	readonly type = BASES_VIEW_TYPE_WATERFALL;
	hoverPopover: HoverPopover | null = null;

	private scrollEl!: HTMLElement;
	private containerEl!: HTMLElement;
	private actionBarEl!: HTMLElement;
	private resizeObserver!: ResizeObserver;
	private lastSelectedIdx?: number;

	private layoutItems: LayoutItem[] = [];
	private columnHeights: number[] = [];
	private numColumns = 1;
	private colWidthSetting = 200;
	private gap = 8;
	private showFilename = true;
	private showProperties = false;

	private actualColWidth = 200;
	private offsetX = 0;
	private rafId: number | null = null;

	private hoverTimer: ReturnType<typeof setTimeout> | null = null;
	private fullscreenOverlay: HTMLElement | null = null;
	private fullscreenItem: LayoutItem | null = null;
	private settingsChangedRef: (() => void) | null = null;
	private getPluginSettings: () => MediaCompanionSettings;

	private lastDataFingerprint = "";
	private lastShowFilename = true;
	private lastShowProperties = false;
	private visibleProperties: BasesPropertyId[] = [];
	private lastPropsFingerprint = "";

	constructor(controller: QueryController, parentEl: HTMLElement, getPluginSettings: () => MediaCompanionSettings) {
		super(controller);
		this.getPluginSettings = getPluginSettings;

		this.actionBarEl = parentEl.createDiv({ cls: "mc-waterfall-action-bar" });
		this.actionBarEl.style.display = "none";
		this.scrollEl = parentEl.createDiv({ cls: "mc-waterfall-scroll" });
		this.containerEl = this.scrollEl.createDiv({ cls: "mc-waterfall-container" });

		this.scrollEl.addEventListener("scroll", () => this.scheduleSync(), { passive: true });

		this.resizeObserver = new ResizeObserver(() => {
			this.relayoutInPlace();
		});
		this.resizeObserver.observe(this.scrollEl);

		this.settingsChangedRef = () => this.refreshVisibleItems();
		this.app.workspace.on("mc:settings-changed" as any, this.settingsChangedRef);
	}

	private scheduleSync(): void {
		if (this.rafId !== null) return;
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.syncDOM();
		});
	}

	public onDataUpdated(): void {
		const newColWidth = Number(this.config.get("columnWidth")) || 200;
		const newGap = Number(this.config.get("gap")) || 8;
		const newShowFilename = this.config.get("showFilename") !== false;
		const newShowProperties = this.config.get("showProperties") === true;

		const newVisibleProperties = this.config.getOrder().filter(pid => {
			const parsed = parsePropertyId(pid);
			
			return !(parsed.type === "file" && parsed.name === "fileName");
		});
		const newPropsFingerprint = newVisibleProperties.join(",");
		this.visibleProperties = newVisibleProperties;

		const filterColorMode = String(this.config.get("filterColorMode") || "include");
		const filterColorPreset = String(this.config.get("filterColorPreset") || "");
		const filterColor = String(this.config.get("filterColor") || "").trim();
		const colorThreshold = parseFloat(String(this.config.get("colorThreshold") || "50"));
		const filterShape = String(this.config.get("filterShape") || "");
		const filterMinWidth = parseInt(String(this.config.get("filterMinWidth") || ""), 10) || 0;
		const filterMaxWidth = parseInt(String(this.config.get("filterMaxWidth") || ""), 10) || 0;
		const filterMinHeight = parseInt(String(this.config.get("filterMinHeight") || ""), 10) || 0;
		const filterMaxHeight = parseInt(String(this.config.get("filterMaxHeight") || ""), 10) || 0;
		const searchQuery = String(this.config.get("searchQuery") || "").trim().toLowerCase();

		const dataIds = this.data.groupedData.flatMap(g => g.entries.map(e => e.file.path)).join("\n");
		const fingerprint = `${dataIds}|${filterColorMode}|${filterColorPreset}|${filterColor}|${colorThreshold}|${filterShape}|${filterMinWidth}|${filterMaxWidth}|${filterMinHeight}|${filterMaxHeight}|${searchQuery}`;

		const layoutOnly = fingerprint === this.lastDataFingerprint && this.layoutItems.length > 0;

		this.colWidthSetting = newColWidth;
		this.gap = newGap;
		this.showFilename = newShowFilename;
		this.showProperties = newShowProperties;

		if (layoutOnly) {
			if (newShowFilename !== this.lastShowFilename) {
				const delta = newShowFilename ? LABEL_HEIGHT : -LABEL_HEIGHT;

				for (const item of this.layoutItems) {
					item.itemHeight += delta;
				}
				
				for (const item of this.layoutItems) {
					if (!item.el) continue;
					
					const existing = item.el.querySelector(".mc-waterfall-name");
					
					if (newShowFilename && !existing) {
						const propsEl = item.el.querySelector(".mc-waterfall-props");
						const nameEl = createDiv({ cls: "mc-waterfall-name", text: item.mediaFile.basename });
						
						if (propsEl) {
							item.el.insertBefore(nameEl, propsEl);
						} else {
							item.el.appendChild(nameEl);
						}
					} else if (!newShowFilename && existing) {
						existing.remove();
					}
				}
			}
			this.lastShowFilename = newShowFilename;

			const propsToggled = newShowProperties !== this.lastShowProperties;
			const propsListChanged = newPropsFingerprint !== this.lastPropsFingerprint;

			if (propsToggled || (newShowProperties && propsListChanged)) {
				// Reset props measurement and re-render on mounted items.
				for (const item of this.layoutItems) {
					// Subtract old props height from the item before resetting
					if (item.propsHeight > 0) {
						item.itemHeight -= item.propsHeight;
					}
					item.propsMeasured = false;
					item.propsHeight = 0;

					if (!item.el) continue;
					
					const existing = item.el.querySelector(".mc-waterfall-props");
					if (existing) existing.remove();

					if (newShowProperties && this.visibleProperties.length > 0) {
						if (item.entry) this.renderProperties(item.el, item.entry);
					}
				}

				// Recompute positions with the props height stripped, then
				// measure newly rendered props and grow items to fit.
				this.relayoutInPlace(true, true);

				if (newShowProperties && this.visibleProperties.length > 0) {
					this.measureMountedProps();
				}
			} else {
				this.relayoutInPlace(true, true);
			}
			
			this.lastShowProperties = newShowProperties;
			this.lastPropsFingerprint = newPropsFingerprint;

			return;
		}

		this.lastDataFingerprint = fingerprint;
		this.lastShowFilename = newShowFilename;
		this.lastShowProperties = newShowProperties;
		this.lastPropsFingerprint = newPropsFingerprint;

		let targetHsl: [number, number, number] | null = null;
		
		const PRESET_COLORS: Record<string, [number, number, number]> = {
			red: [0, 1, 0.5],
			orange: [30, 1, 0.5],
			yellow: [60, 1, 0.5],
			green: [120, 1, 0.5],
			blue: [240, 1, 0.5],
			purple: [300, 1, 0.25],
			pink: [300, 1, 0.75],
			brown: [30, 1, 0.25],
			black: [0, 0, 0],
			white: [0, 0, 1],
			gray: [0, 0, 0.5],
		};

		if (filterColorPreset && PRESET_COLORS[filterColorPreset]) {
			targetHsl = PRESET_COLORS[filterColorPreset];
		} else if (filterColor) {
			const rgb = hexToRgb(filterColor);
			if (rgb) targetHsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
		}

		const previouslySelectedPaths = new Set(this.layoutItems.filter(i => i.selected).map(i => i.mediaFile.path));

		this.clearDOM();
		this.layoutItems = [];

		const seenMediaPaths = new Set<string>();
		const itemByMediaPath = new Map<string, LayoutItem>();
		const foldersInResult = new Set<string>();
		let deduplicatedCount = 0;

		for (const group of this.data.groupedData) {
			for (const entry of group.entries) {
				const resolved = this.resolveMediaFile(entry.file);
				if (!resolved) continue;

				const { mediaFile, sidecarFile } = resolved;

				if (mediaFile.parent) foldersInResult.add(mediaFile.parent.path);

				if (seenMediaPaths.has(mediaFile.path)) {
					// Prefer the sidecar-backed entry so properties are available
					if (entry.file.path.endsWith(Sidecar.EXTENSION)) {
						const existing = itemByMediaPath.get(mediaFile.path);
						if (existing) {
							existing.sidecarFile = sidecarFile;
							existing.entry = entry;
						}
					}
					deduplicatedCount++;
					continue;
				}
				seenMediaPaths.add(mediaFile.path);

				const meta = this.readSidecarMeta(sidecarFile);

				if (searchQuery && !mediaFile.path.toLowerCase().includes(searchQuery)) continue;
				if (filterShape && meta.width > 0 && meta.height > 0 && getShape(meta.width, meta.height) !== filterShape) continue;
				if (filterMinWidth > 0 && meta.width > 0 && meta.width < filterMinWidth) continue;
				if (filterMaxWidth > 0 && meta.width > 0 && meta.width > filterMaxWidth) continue;
				if (filterMinHeight > 0 && meta.height > 0 && meta.height < filterMinHeight) continue;
				if (filterMaxHeight > 0 && meta.height > 0 && meta.height > filterMaxHeight) continue;

				if (filterColorMode === "grayscale" && meta.colors) {
					if (!isGrayscale(meta.colors)) continue;
				} else if (filterColorMode === "colorful" && meta.colors) {
					if (isGrayscale(meta.colors)) continue;
				} else if (targetHsl && meta.colors) {
					const isClose = isColorWithinThreshold(targetHsl[0], targetHsl[1], targetHsl[2], meta.colors, colorThreshold / 100);
					if (filterColorMode === "include" && !isClose) continue;
					if (filterColorMode === "exclude" && isClose) continue;
				}

				const item: LayoutItem = {
					mediaFile, sidecarFile, entry,
					metaWidth: meta.width, metaHeight: meta.height,
					colors: meta.colors,
					col: 0, x: 0, y: 0, itemHeight: 0,
					measured: false, propsMeasured: false, propsHeight: 0, el: null,
					selected: previouslySelectedPaths.has(mediaFile.path),
				};
				this.layoutItems.push(item);
				itemByMediaPath.set(mediaFile.path, item);
			}
		}

		// When the Bases limit counted both a media file and its sidecar as separate entries, 
		// our dedup reduced the visible count. Fill the remainder by scanning the vault for
		// additional sidecar-backed media files in the same folders.
		if (deduplicatedCount > 0) {
			let remaining = deduplicatedCount;
			
			for (const folderPath of foldersInResult) {
				if (remaining <= 0) break;
				
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				
				if (!(folder instanceof TFolder)) continue;
				
				for (const child of folder.children) {
					if (remaining <= 0) break;
					
					if (!child.path.endsWith(Sidecar.EXTENSION)) continue;
					
					const mediaPath = child.path.slice(0, -Sidecar.EXTENSION.length);
					
					if (seenMediaPaths.has(mediaPath)) continue;
					
					const sidecarFile = this.app.vault.getFileByPath(child.path);
					
					if (!sidecarFile) continue;
					
					const mediaFile = this.app.vault.getFileByPath(mediaPath);
					
					if (!mediaFile) continue;

					seenMediaPaths.add(mediaPath);
					const meta = this.readSidecarMeta(sidecarFile);

					if (searchQuery && !mediaFile.path.toLowerCase().includes(searchQuery)) continue;
					if (filterShape && meta.width > 0 && meta.height > 0 && getShape(meta.width, meta.height) !== filterShape) continue;
					if (filterMinWidth > 0 && meta.width > 0 && meta.width < filterMinWidth) continue;
					if (filterMaxWidth > 0 && meta.width > 0 && meta.width > filterMaxWidth) continue;
					if (filterMinHeight > 0 && meta.height > 0 && meta.height < filterMinHeight) continue;
					if (filterMaxHeight > 0 && meta.height > 0 && meta.height > filterMaxHeight) continue;
					if (filterColorMode === "grayscale" && meta.colors) {
						if (!isGrayscale(meta.colors)) continue;
					} else if (filterColorMode === "colorful" && meta.colors) {
						if (isGrayscale(meta.colors)) continue;
					} else if (targetHsl && meta.colors) {
						const isClose = isColorWithinThreshold(targetHsl[0], targetHsl[1], targetHsl[2], meta.colors, colorThreshold / 100);
						if (filterColorMode === "include" && !isClose) continue;
						if (filterColorMode === "exclude" && isClose) continue;
					}

					this.layoutItems.push({
						mediaFile, sidecarFile, entry: null,
						metaWidth: meta.width, metaHeight: meta.height,
						colors: meta.colors,
						col: 0, x: 0, y: 0, itemHeight: 0,
						measured: false, propsMeasured: false, propsHeight: 0, el: null,
						selected: previouslySelectedPaths.has(mediaFile.path),
					});
					remaining--;
				}
			}
		}

		if (this.layoutItems.length === 0) {
			this.containerEl.style.height = "";
			
			this.containerEl.createDiv({
				cls: "mc-waterfall-empty",
				text: "No media files found. Make sure your Base queries sidecar (.sidecar.md) files or supported media files.",
			});
			
			return;
		}

		this.computePositions();
		this.syncDOM();
		this.updateActionBar();
	}

	private get footerHeight(): number {
		let h = 0;
		if (this.showFilename) h += LABEL_HEIGHT;
		return h;
	}

	private computePositions(): void {
		const clientW = this.scrollEl.clientWidth || 400;
		const available = clientW - PADDING * 2;
		
		this.numColumns = Math.max(1, Math.floor((available + this.gap) / (this.colWidthSetting + this.gap)));
		this.actualColWidth = (available - (this.numColumns - 1) * this.gap) / this.numColumns;

		const totalUsed = this.numColumns * this.actualColWidth + (this.numColumns - 1) * this.gap;
		
		this.offsetX = (clientW - totalUsed) / 2;
		this.columnHeights = new Array(this.numColumns).fill(PADDING);

		for (const item of this.layoutItems) {
			const col = this.shortestColumn();
			
			item.col = col;
			item.x = this.offsetX + col * (this.actualColWidth + this.gap);
			item.y = this.columnHeights[col];

			if (!item.measured) {
				const mediaH = item.metaWidth > 0 && item.metaHeight > 0
					? (this.actualColWidth / item.metaWidth) * item.metaHeight
					: this.actualColWidth; // square fallback
				item.itemHeight = mediaH + this.footerHeight + item.propsHeight;
			}
			this.columnHeights[col] += item.itemHeight + this.gap;
		}

		this.containerEl.style.height = `${Math.max(0, ...this.columnHeights)}px`;
	}

	private shortestColumn(): number {
		let min = 0;
		for (let i = 1; i < this.numColumns; i++) {
			if (this.columnHeights[i] < this.columnHeights[min]) min = i;
		}
		return min;
	}

	private relayoutInPlace(force = false, animate = false): void {
		if (this.layoutItems.length === 0) return;

		const oldColWidth = this.actualColWidth;
		const available = (this.scrollEl.clientWidth || 400) - PADDING * 2;
		const newNumCols = Math.max(1, Math.floor((available + this.gap) / (this.colWidthSetting + this.gap)));
		const newColWidth = (available - (newNumCols - 1) * this.gap) / newNumCols;

		if (!force && newNumCols === this.numColumns && Math.abs(newColWidth - oldColWidth) < 0.5) return;

		// Suppress animated transitions during resize so the relayout is instant,
		// but keep them when the caller explicitly requests animation (e.g. toggling props).
		if (!animate) {
			this.containerEl.classList.add("mc-no-transition");
		}

		const scale = newColWidth / (oldColWidth || 1);

		for (const item of this.layoutItems) {
			if (item.measured) {
				const footer = this.footerHeight + item.propsHeight;
				
				item.itemHeight = (item.itemHeight - footer) * scale + footer;
			}
		}

		this.computePositions();

		for (const item of this.layoutItems) {
			if (!item.el) continue;
			
			item.el.style.top = `${item.y}px`;
			item.el.style.left = `${item.x}px`;
			item.el.style.width = `${this.actualColWidth}px`;
			item.el.style.height = `${item.itemHeight}px`;
		}

		this.syncDOM();

		// Re-enable transitions after the browser has painted the new positions.
		if (!animate) {
			requestAnimationFrame(() => {
				this.containerEl.classList.remove("mc-no-transition");
			});
		}
	}

	private reflowColumn(changed: LayoutItem, newHeight: number): void {
		const delta = newHeight - changed.itemHeight;
		if (Math.abs(delta) < 1) return;

		changed.itemHeight = newHeight;
		if (changed.el) changed.el.style.height = `${newHeight}px`;

		const col = changed.col;
		let past = false;

		for (const item of this.layoutItems) {
			if (item === changed) { past = true; continue; }
			if (!past || item.col !== col) continue;
			
			item.y += delta;
			
			if (item.el) item.el.style.top = `${item.y}px`;
		}

		this.columnHeights[col] += delta;
		this.containerEl.style.height = `${Math.max(0, ...this.columnHeights)}px`;

		this.syncDOM();
	}

	/**
	 * Measure the rendered props height of all mounted items that haven't
	 * been measured yet, and grow them to fit.  Used after toggling props on
	 * so the layout adjusts to the new content.
	 */
	private measureMountedProps(): void {
		requestAnimationFrame(() => {
			for (const item of this.layoutItems) {
				if (item.propsMeasured || !item.el) continue;
				const propsEl = item.el.querySelector(".mc-waterfall-props") as HTMLElement | null;
				const propsH = propsEl ? propsEl.offsetHeight : 0;
				item.propsMeasured = true;
				item.propsHeight = propsH;
				if (propsH > 0) {
					const newH = item.itemHeight + propsH;
					item.el.style.height = `${newH}px`;
					this.reflowColumn(item, newH);
				}
			}
		});
	}

	private syncDOM(): void {
		const scrollTop = this.scrollEl.scrollTop;
		const viewHeight = this.scrollEl.clientHeight;
		const top = scrollTop - BUFFER_PX;
		const bottom = scrollTop + viewHeight + BUFFER_PX;

		for (const item of this.layoutItems) {
			const inView = item.y + item.itemHeight > top && item.y < bottom;

			if (inView && !item.el) {
				this.mountItem(item);
			} else if (!inView && item.el) {
				item.el.remove();
				item.el = null;
			}
		}
	}

	private clearDOM(): void {
		for (const item of this.layoutItems) {
			if (item.el) { item.el.remove(); item.el = null; }
		}
		
		this.containerEl.empty();
	}

	private mountItem(item: LayoutItem): void {
		const el = this.containerEl.createDiv({ cls: "mc-waterfall-item" });
		item.el = el;

		if (item.selected) el.classList.add("is-selected");

		const cb = el.createDiv({ cls: "mc-waterfall-checkbox" });
		if (item.selected) cb.classList.add("is-checked");

		el.style.top = `${item.y}px`;
		el.style.left = `${item.x}px`;
		el.style.width = `${this.actualColWidth}px`;
		el.style.height = `${item.itemHeight}px`;

		const mc = el.createDiv({ cls: "mc-waterfall-media" });
		const mediaH = item.itemHeight - this.footerHeight;
		const ph = mc.createDiv({ cls: "mc-waterfall-placeholder" });
		
		ph.style.height = `${Math.max(mediaH, 50)}px`;

		this.loadMediaContent(item, el, mc);

		// Read fullscreen settings fresh from the plugin each time an item is mounted
		// so that changes in plugin settings take effect without a full re-render.
		const { fullscreenMode: fsMode, fullscreenHoverDelay: fsDelay } = this.getPluginSettings();

		if (fsMode !== "off") {
			const btn = mc.createDiv({ cls: "mc-waterfall-fullscreen-btn" });
			setIcon(btn, "zoom-in");

			if (fsMode === "hover") {
				btn.addEventListener("mouseenter", () => {
					this.clearHoverTimer();
					this.hoverTimer = setTimeout(() => {
						this.showFullscreen(item);
					}, fsDelay);
				});
				btn.addEventListener("mouseleave", () => {
					this.clearHoverTimer();
				});
			}

			btn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.showFullscreen(item);
			});
		}

		if (this.showFilename) {
			el.createDiv({ cls: "mc-waterfall-name", text: item.mediaFile.basename });
		}

		if (this.showProperties && this.visibleProperties.length > 0) {
			if (item.entry) this.renderProperties(el, item.entry);
		}

		// The pre-calculated itemHeight covers media + filename only.
		// Measure the actual rendered props height (which may wrap) and
		// grow the item to fit.
		if (!item.propsMeasured && this.showProperties && this.visibleProperties.length > 0) {
			// Allow overflow so the props are laid out at their natural
			// height even though the explicit item height is too short.
			el.style.overflow = "visible";
			requestAnimationFrame(() => {
				if (!item.el || item.propsMeasured) return;
				const propsEl = item.el.querySelector(".mc-waterfall-props") as HTMLElement | null;
				const propsH = propsEl ? propsEl.offsetHeight : 0;
				item.propsMeasured = true;
				item.propsHeight = propsH;
				item.el.style.overflow = "";
				if (propsH > 0) {
					const newH = item.itemHeight + propsH;
					item.el.style.height = `${newH}px`;
					this.reflowColumn(item, newH);
				}
			});
		}

		el.setAttribute("draggable", "true");
		el.addEventListener("dragstart", (evt) => {
			if (!evt.dataTransfer) return;
			
			const resourcePath = this.app.vault.getResourcePath(item.mediaFile);
			evt.dataTransfer.setData("text/uri-list", resourcePath);
			evt.dataTransfer.setData("text/plain", item.mediaFile.path);
			evt.dataTransfer.effectAllowed = "copy";

			const img = el.querySelector("img");
			
			if (img) evt.dataTransfer.setDragImage(img, 0, 0);
		});

		el.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			const menu = new Menu();

			menu.addItem((mi) =>
				mi.setTitle("Copy Image (Content)")
					.setIcon("image")
					.onClick(() => void this.copyMediaToClipboard(item.mediaFile))
			);

			menu.addItem((mi) =>
				mi.setTitle("Copy Obsidian Link")
					.setIcon("link")
					.onClick(() => {
						navigator.clipboard.writeText(`![[${item.mediaFile.path}]]`);
						new Notice("Link copied to clipboard");
					})
			);

			menu.addItem((mi) =>
				mi.setTitle("Reveal in Navigation")
					.setIcon("folder")
					.onClick(() => {
						// @ts-ignore
						const explorerLeaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
						if (explorerLeaf) {
							this.app.workspace.revealLeaf(explorerLeaf);
							// @ts-ignore
							explorerLeaf.view.revealInFolder(item.mediaFile);
						}
					})
			);

			menu.addItem((mi) =>
				mi.setTitle("Show in System Explorer")
					.setIcon("folder-open")
					.onClick(() => {
						// @ts-ignore
						this.app.showInFolder(item.mediaFile.path);
					})
			);

			menu.addItem((mi) =>
				mi.setTitle("Rename")
					.setIcon("pencil")
					.onClick(() => {
						new RenameModal(this.app, item.mediaFile, item.sidecarFile).open();
					})
			);

			menu.addItem((mi) =>
				mi.setTitle("Move")
					.setIcon("folder-input")
					.onClick(() => {
						new MoveModal(this.app, [item]).open();
					})
			);

			menu.addItem((mi) =>
				mi.setTitle("Delete")
					.setIcon("trash")
					.onClick(() => void this.deleteMediaFile(item))
			);

			menu.showAtMouseEvent(evt);
		});

		el.addEventListener("click", (evt) => {
			if (evt.button !== 0 && evt.button !== 1) return;
			
			const hasSelectedItems = this.layoutItems.some(i => i.selected);

			if (evt.target === cb || evt.shiftKey || hasSelectedItems) {
				evt.preventDefault();
				evt.stopPropagation();
				
				const idx = this.layoutItems.indexOf(item);
				
				if (evt.shiftKey && this.lastSelectedIdx !== undefined && this.lastSelectedIdx !== -1) {
					const start = Math.min(this.lastSelectedIdx, idx);
					const end = Math.max(this.lastSelectedIdx, idx);
					
					for (let i = start; i <= end; i++) {
						const it = this.layoutItems[i];
						it.selected = true;
						if (it.el) {
							it.el.classList.add("is-selected");
							const checkbox = it.el.querySelector(".mc-waterfall-checkbox");
							if (checkbox) checkbox.classList.add("is-checked");
						}
					}
				} else {
					item.selected = !item.selected;
					if (item.selected) {
						el.classList.add("is-selected");
						cb.classList.add("is-checked");
						this.lastSelectedIdx = idx;
					} else {
						el.classList.remove("is-selected");
						cb.classList.remove("is-checked");
						this.lastSelectedIdx = idx;
					}
				}
				this.updateActionBar();
				
				if (evt.target !== cb && !evt.shiftKey) {
					if (Keymap.isModEvent(evt)) {
						const newLeaf = this.app.workspace.getLeaf("tab");
						void newLeaf.setViewState({
							type: VIEW_TYPE_SIDECAR,
							state: { file: item.mediaFile.path },
						});
						this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
					} else {
						void this.openInSidebar(item.mediaFile);
					}
				}
				return;
			}
			
			evt.preventDefault();

			if (Keymap.isModEvent(evt)) {
				const newLeaf = this.app.workspace.getLeaf("tab");
				
				void newLeaf.setViewState({
					type: VIEW_TYPE_SIDECAR,
					state: { file: item.mediaFile.path },
				});
				
				this.app.workspace.setActiveLeaf(newLeaf, { focus: true });
			} else {
				void this.openInSidebar(item.mediaFile);
			}
		});

		el.addEventListener("mouseover", (evt) => {
			this.app.workspace.trigger("hover-link", {
				event: evt,
				source: "mc-waterfall",
				hoverParent: this,
				targetEl: el,
				linktext: item.mediaFile.path,
			});
		});

	}

	private loadMediaContent(item: LayoutItem, el: HTMLElement, mc: HTMLElement): void {
		const resourcePath = this.app.vault.getResourcePath(item.mediaFile);
		const mediaType = getMediaType(item.mediaFile.extension);

		const onSized = (naturalW: number, naturalH: number) => {
			const ph = mc.querySelector(".mc-waterfall-placeholder");
			
			if (ph) ph.remove();

			if (item.measured) return; // height already correct
			
			item.measured = true;

			const mediaH = naturalH * (this.actualColWidth / naturalW);
			let newH = mediaH + this.footerHeight;

			// If props were already measured, preserve that extra height.
			if (item.propsMeasured) {
				const propsEl = item.el?.querySelector(".mc-waterfall-props") as HTMLElement | null;
				if (propsEl) newH += propsEl.offsetHeight;
			}

			this.reflowColumn(item, newH);
		};

		if (mediaType === MediaTypes.Image) {
			const isGif = item.mediaFile.extension.toLowerCase() === "gif";
			const img = mc.createEl("img", {
				attr: { src: resourcePath, alt: item.mediaFile.basename },
			});

			let staticSrc: string | null = null;

			img.addEventListener("load", () => {
				onSized(img.naturalWidth, img.naturalHeight);
				
				// If it's a GIF and we haven't generated the static thumbnail yet
				if (isGif && !staticSrc) {
					// We must fetch the binary to avoid Tainted Canvas errors from app://local
					this.app.vault.readBinary(item.mediaFile).then((data) => {
						const blob = new Blob([data], { type: "image/gif" });
						const url = URL.createObjectURL(blob);
						const tempImg = new Image();
						
						tempImg.onload = () => {
							const canvas = document.createElement("canvas");
							canvas.width = tempImg.naturalWidth;
							canvas.height = tempImg.naturalHeight;
							const ctx = canvas.getContext("2d");
							
							if (ctx) {
								ctx.drawImage(tempImg, 0, 0);
								staticSrc = canvas.toDataURL("image/png");
								// Swap to static image immediately to "pause" it, unless we are currently hovering
								if (!img.matches(":hover")) {
									img.src = staticSrc;
								}
							}
							URL.revokeObjectURL(url);
						};
						
						tempImg.src = url;
					}).catch(e => console.error("Failed to generate static GIF thumbnail", e));
				}
			});

			if (isGif) {
				// Emulate video playback on hover
				img.addEventListener("mouseenter", () => {
					if (staticSrc) img.src = resourcePath;
				});
				img.addEventListener("mouseleave", () => {
					if (staticSrc) img.src = staticSrc;
				});
			}
		} else if (mediaType === MediaTypes.Video) {
			const video = mc.createEl("video", {
				attr: { src: resourcePath, preload: "metadata", muted: "" },
			});

			video.addEventListener("mouseenter", () => { video.play().catch(() => {}); });
			video.addEventListener("mouseleave", () => { video.pause(); video.currentTime = 0; });
			video.addEventListener("loadedmetadata", () => onSized(video.videoWidth, video.videoHeight));
		} else {
			const embedCreator = this.app.embedRegistry.getEmbedCreator(item.mediaFile);
			
			if (embedCreator) {
				const embedEl = mc.createDiv();
				const embed = embedCreator({ app: this.app, containerEl: embedEl }, item.mediaFile, item.mediaFile.path);
				// @ts-ignore – loadFile exists on embed components
				if (embed.loadFile) embed.loadFile();
			} else {
				mc.createDiv({ text: item.mediaFile.basename, cls: "mc-waterfall-name" });
			}
			
			item.measured = true;
			const ph = mc.querySelector(".mc-waterfall-placeholder");
			
			if (ph) ph.remove();
		}
	}

	private resolveMediaFile(file: TFile): { mediaFile: TFile; sidecarFile: TFile | null } | null {
		if (file.path.endsWith(Sidecar.EXTENSION)) {
			const mediaPath = file.path.slice(0, -Sidecar.EXTENSION.length);
			const mediaFile = this.app.vault.getFileByPath(mediaPath);
			
			return mediaFile ? { mediaFile, sidecarFile: file } : null;
		}

		const mediaType = getMediaType(file.extension);
		
		if (mediaType !== MediaTypes.Unknown) {
			const sidecarFile = this.app.vault.getFileByPath(`${file.path}${Sidecar.EXTENSION}`);
			
			return { mediaFile: file, sidecarFile };
		}

		return null;
	}

	private readSidecarMeta(sidecarFile: TFile | null): {
		width: number;
		height: number;
		colors: { h: number; s: number; l: number; area: number }[] | null;
	} {
		if (!sidecarFile) return { width: 0, height: 0, colors: null };

		const cache = this.app.metadataCache.getFileCache(sidecarFile);
		const fm = cache?.frontmatter;
		
		if (!fm) return { width: 0, height: 0, colors: null };

		let width = 0, height = 0;
		const size = fm["MC-size"];
		
		if (Array.isArray(size) && size.length === 2) {
			width = Number(size[0]) || 0;
			height = Number(size[1]) || 0;
		}

		let colors = null;
		const raw = fm["MC-colors"];
		
		if (Array.isArray(raw)) colors = raw as { h: number; s: number; l: number; area: number }[];

		return { width, height, colors };
	}

	private renderProperties(parentEl: HTMLElement, entry: BasesEntry): void {
		const propsEl = parentEl.createDiv({ cls: "mc-waterfall-props" });
		
		for (const pid of this.visibleProperties) {
			const val = entry.getValue(pid);
			const name = this.config.getDisplayName(pid);
			const propEl = propsEl.createDiv({ cls: "mc-waterfall-prop" });

			const nameSpan = propEl.createSpan({ cls: "mc-waterfall-prop-name" });
			nameSpan.textContent = `${name}: `;

			const valueSpan = propEl.createSpan({ cls: "mc-waterfall-prop-value" });
			this.renderPropertyValue(valueSpan, val);
		}
	}

	private renderPropertyValue(container: HTMLElement, val: unknown): void {
		if (val == null || val === "null" || val === "undefined") {
			container.appendText("-");
			return;
		}

		if (Array.isArray(val)) {
			if (val.length === 0) {
				container.appendText("-");
				return;
			}
			for (let i = 0; i < val.length; i++) {
				if (i > 0) container.appendText(", ");
				this.renderPropertyValue(container, val[i]);
			}
			return;
		}

		// Obsidian link objects have a `path` property
		if (typeof val === "object" && val !== null && "path" in val) {
			const linkObj = val as { path: string; display?: string };
			const a = container.createEl("a", {
				cls: "mc-prop-link",
				text: linkObj.display || linkObj.path.split("/").pop()?.replace(/\.[^.]+$/, "") || linkObj.path,
			});
			a.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.app.workspace.openLinkText(linkObj.path, "", Keymap.isModEvent(evt));
			});
			return;
		}

		const text = String(val);

		if (text === "" || text === "null" || text === "undefined") {
			container.appendText("-");
			return;
		}

		// Wiki-links: [[Page]] or [[Page|Display]]
		const wikiLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
		if (wikiLinkRegex.test(text)) {
			wikiLinkRegex.lastIndex = 0;
			let lastIndex = 0;
			let match;
			while ((match = wikiLinkRegex.exec(text)) !== null) {
				if (match.index > lastIndex) {
					container.appendText(text.slice(lastIndex, match.index));
				}
				const linkPath = match[1].trim();
				const display = match[2]?.trim() || linkPath.split("/").pop()?.replace(/\.[^.]+$/, "") || linkPath;
				const a = container.createEl("a", { cls: "mc-prop-link", text: display });
				a.addEventListener("click", (evt) => {
					evt.preventDefault();
					evt.stopPropagation();
					this.app.workspace.openLinkText(linkPath, "", Keymap.isModEvent(evt));
				});
				lastIndex = match.index + match[0].length;
			}
			if (lastIndex < text.length) {
				container.appendText(text.slice(lastIndex));
			}
			return;
		}

		// Tags: strings containing #tag tokens
		const tagRegex = /#[^\s#,]+/g;
		if (tagRegex.test(text)) {
			tagRegex.lastIndex = 0;
			let lastIndex = 0;
			let match;
			while ((match = tagRegex.exec(text)) !== null) {
				if (match.index > lastIndex) {
					container.appendText(text.slice(lastIndex, match.index));
				}
				const tagText = match[0];
				const tag = container.createSpan({ cls: "mc-prop-tag", text: tagText });
				tag.addEventListener("click", (evt) => {
					evt.preventDefault();
					evt.stopPropagation();
					// @ts-ignore – global search for tag
					this.app.internalPlugins?.getPluginById?.("global-search")?.instance?.openGlobalSearch?.(`tag:${tagText}`);
				});
				lastIndex = match.index + match[0].length;
			}
			if (lastIndex < text.length) {
				container.appendText(text.slice(lastIndex));
			}
			return;
		}

		// URL strings
		if (text.startsWith("http://") || text.startsWith("https://")) {
			const a = container.createEl("a", { cls: "mc-prop-link", text });
			a.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				window.open(text, "_blank");
			});
			return;
		}

		container.appendText(text);
	}

	private async copyMediaToClipboard(mediaFile: TFile): Promise<void> {
		try {
			const data = await this.app.vault.readBinary(mediaFile);
			const srcMime = this.getMimeType(mediaFile.extension);

			// The Clipboard API only supports image/png for writing.
			// If the source is already PNG, write directly; otherwise
			// draw onto a canvas and export as PNG.
			let pngBlob: Blob;
			if (srcMime === "image/png") {
				pngBlob = new Blob([data], { type: "image/png" });
			} else if (srcMime.startsWith("image/")) {
				pngBlob = await this.convertToPng(data, srcMime);
			} else {
				// Non-image files fall back to plain text path
				await navigator.clipboard.writeText(mediaFile.path);
				new Notice(`Copied path of ${mediaFile.basename} to clipboard`);
				return;
			}

			await navigator.clipboard.write([
				new ClipboardItem({ "image/png": pngBlob }),
			]);

			new Notice(`Copied ${mediaFile.basename} to clipboard`);

		} catch (e) {
			console.error("Failed to copy media to clipboard", e);

			new Notice("Failed to copy media to clipboard");
		}
	}

	private convertToPng(data: ArrayBuffer, mimeType: string): Promise<Blob> {
		return new Promise((resolve, reject) => {
			const blob = new Blob([data], { type: mimeType });
			const url = URL.createObjectURL(blob);
			const img = new Image();
			
			img.onload = () => {
				const canvas = document.createElement("canvas");
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
				const ctx = canvas.getContext("2d");
				if (!ctx) { URL.revokeObjectURL(url); reject(new Error("Canvas 2D context unavailable")); return; }
				ctx.drawImage(img, 0, 0);
				canvas.toBlob((pngBlob) => {
					URL.revokeObjectURL(url);
					if (pngBlob) resolve(pngBlob);
					else reject(new Error("Canvas toBlob returned null"));
				}, "image/png");
			};
			
			img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image for conversion")); };
			img.src = url;
		});
	}

	private async deleteMediaFile(item: LayoutItem): Promise<void> {
		try {
			// Trash the sidecar first (if it exists)
			if (item.sidecarFile) {
				await this.app.fileManager.trashFile(item.sidecarFile);
			}

			await this.app.fileManager.trashFile(item.mediaFile);

			if (item.el) { item.el.remove(); item.el = null; }

			this.layoutItems = this.layoutItems.filter(i => i !== item);
			this.computePositions();
			this.syncDOM();
		} catch (e) {
			console.error("Failed to delete media file", e);
			new Notice("Failed to delete file");
		}
	}

	private getMimeType(ext: string): string {
		const map: Record<string, string> = {
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			gif: "image/gif",
			webp: "image/webp",
			svg: "image/svg+xml",
			bmp: "image/bmp",
			mp4: "video/mp4",
			webm: "video/webm",
			ogv: "video/ogg",
		};
		return map[ext.toLowerCase()] || "application/octet-stream";
	}

	private clearHoverTimer(): void {
		if (this.hoverTimer !== null) {
			clearTimeout(this.hoverTimer);
			this.hoverTimer = null;
		}
	}

	private showFullscreen(item: LayoutItem): void {
		if (this.fullscreenOverlay) this.dismissFullscreen();

		const overlay = document.body.createDiv({ cls: "mc-waterfall-fullscreen" });
		this.fullscreenOverlay = overlay;
		this.fullscreenItem = item;

		const resourcePath = this.app.vault.getResourcePath(item.mediaFile);
		const mediaType = getMediaType(item.mediaFile.extension);

		if (mediaType === MediaTypes.Video) {
			const video = overlay.createEl("video", {
				cls: "mc-waterfall-fullscreen-media",
				attr: { src: resourcePath, autoplay: "", controls: "", muted: "" },
			});
			video.play().catch(() => {});
		} else {
			overlay.createEl("img", {
				cls: "mc-waterfall-fullscreen-media",
				attr: { src: resourcePath, alt: item.mediaFile.basename },
			});
		}

		if (this.showFilename) {
			overlay.createDiv({ cls: "mc-waterfall-fullscreen-label", text: item.mediaFile.basename });
		}

		overlay.addEventListener("click", () => this.dismissFullscreen());
		overlay.addEventListener("mouseleave", () => this.dismissFullscreen());

		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.dismissFullscreen();
		};
		document.addEventListener("keydown", onKey, { once: true });
	}

	private dismissFullscreen(): void {
		if (this.fullscreenOverlay) {
			this.fullscreenOverlay.remove();
			this.fullscreenOverlay = null;
			this.fullscreenItem = null;
		}
	}

	private async openInSidebar(mediaFile: TFile): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;

		for (const l of workspace.getLeavesOfType(VIEW_TYPE_SIDECAR)) {
			if (l.getRoot() === workspace.rightSplit) {
				leaf = l;
				break;
			}
		}

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return;
		}

		await leaf.setViewState({
			type: VIEW_TYPE_SIDECAR,
			state: { file: mediaFile.path },
		});

		workspace.revealLeaf(leaf);
	}

	/**
	 * Unmount and re-mount all currently visible items so they pick up
	 * the latest plugin settings (e.g. fullscreen mode changes).
	 */
	private refreshVisibleItems(): void {
		for (const item of this.layoutItems) {
			if (item.el) {
				item.el.remove();
				item.el = null;
			}
		}
		this.syncDOM();
	}

	private updateActionBar() {
		const selectedItems = this.layoutItems.filter((i) => i.selected);
		if (selectedItems.length > 0) {
			this.actionBarEl.style.display = "flex";
			this.actionBarEl.empty();

			this.actionBarEl.createDiv({ cls: "mc-waterfall-action-bar-text", text: `${selectedItems.length} items selected` });

			const btnContainer = this.actionBarEl.createDiv({ cls: "mc-waterfall-action-bar-buttons" });

			const selectAllBtn = btnContainer.createEl("button", { text: "Select All", cls: "mc-waterfall-btn" });
			selectAllBtn.addEventListener("click", () => {
				for (const item of this.layoutItems) {
					item.selected = true;
					if (item.el) {
						item.el.classList.add("is-selected");
						const cb = item.el.querySelector(".mc-waterfall-checkbox");
						if (cb) cb.classList.add("is-checked");
					}
				}
				this.updateActionBar();
			});

			const editBtn = btnContainer.createEl("button", { text: "Edit Properties" });
			editBtn.addEventListener("click", () => {
				new BulkEditModal(this.app, selectedItems).open();
			});

			const moveBtn = btnContainer.createEl("button", { text: "Move" });
			moveBtn.addEventListener("click", () => {
				new MoveModal(this.app, selectedItems).open();
			});

			const copyBtn = btnContainer.createEl("button", { text: "Copy Links" });
			copyBtn.addEventListener("click", () => {
				const links = selectedItems.map(i => `![[${i.mediaFile.path}]]`).join("\n");
				navigator.clipboard.writeText(links);
				new Notice(`${selectedItems.length} links copied to clipboard`);
				this.updateActionBar();
			});

			const rebuildBtn = btnContainer.createEl("button", { text: "Rebuild Metadata" });
			rebuildBtn.addEventListener("click", async () => {
				const total = selectedItems.length;
				const progressNotice = new Notice(`Rebuilding 0/${total} items...`, 0);
				let count = 0;

				for (const item of selectedItems) {
					count++;
					progressNotice.setMessage(`Rebuilding ${count}/${total} items...`);
					try {
						if (!item.sidecarFile) continue;

						const src = this.app.vault.getResourcePath(item.mediaFile);
						
						// 1. Read size
						const sizePromise = new Promise<{width: number, height: number}>((resolve, reject) => {
							const img = new Image();
							img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
							img.onerror = reject;
							img.src = src;
						});

						const size = await sizePromise;

						// 2. Read colors
						const extracted = await extractColors(src, { pixels: 64000 });
						const colors = extracted.map((e: any) => ({
							h: e.hue,
							s: e.saturation,
							l: e.lightness,
							area: e.area
						}));

						// 3. Process frontmatter
						await this.app.fileManager.processFrontMatter(item.sidecarFile, (fm) => {
							fm["MC-colors"] = colors;
							fm["MC-size"] = [size.width, size.height];
							fm["MC-last-updated"] = new Date().toISOString();
						});

						// Update type manager for datetime if possible
						const typeManager = (this.app as any).metadataTypeManager;
						if (typeManager && typeManager.properties["mc-last-updated"]) {
							typeManager.properties["mc-last-updated"].type = "datetime";
						}
					} catch (e) {
						console.error("Failed to rebuild", item.mediaFile.path, e);
					}
				}
				
				progressNotice.hide();
				new Notice(`Rebuilt metadata for ${total} items successfully!`);
				
				// Deselect after rebuilding
				for (const item of selectedItems) {
					item.selected = false;
					if (item.el) {
						item.el.classList.remove("is-selected");
						const cb = item.el.querySelector(".mc-waterfall-checkbox");
						if (cb) cb.classList.remove("is-checked");
					}
				}
				this.updateActionBar();
			});

			const deleteBtn = btnContainer.createEl("button", { text: "Delete" });
			deleteBtn.addEventListener("click", async () => {
				const total = selectedItems.length;
				const progressNotice = new Notice(`Deleting 0/${total} items...`, 0);
				let count = 0;
				for (const item of selectedItems) {
					count++;
					progressNotice.setMessage(`Deleting ${count}/${total} items...`);
					try {
						if (item.sidecarFile) await this.app.fileManager.trashFile(item.sidecarFile);
						await this.app.fileManager.trashFile(item.mediaFile);
						if (item.el) { item.el.remove(); item.el = null; }
						this.layoutItems = this.layoutItems.filter(i => i !== item);
					} catch (e) {
						console.error("Failed to delete", e);
					}
				}
				progressNotice.hide();
				new Notice(`Deleted ${total} items successfully!`);
				
				this.computePositions();
				this.syncDOM();
				this.updateActionBar();
			});

			const clearBtn = btnContainer.createEl("button", { text: "Clear Selection" });
			clearBtn.addEventListener("click", () => {
				for (const item of this.layoutItems) {
					item.selected = false;
					if (item.el) {
						item.el.classList.remove("is-selected");
						const cb = item.el.querySelector(".mc-waterfall-checkbox");
						if (cb) cb.classList.remove("is-checked");
					}
				}
				this.updateActionBar();
			});
		} else {
			this.actionBarEl.style.display = "none";
		}
	}

	onunload(): void {
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		this.clearHoverTimer();
		this.dismissFullscreen();
		this.resizeObserver.disconnect();
		if (this.settingsChangedRef) {
			this.app.workspace.off("mc:settings-changed" as any, this.settingsChangedRef);
		}
		this.clearDOM();
	}
}

export function getWaterfallViewOptions(): any[] {
	return [
		{
			type: "group",
			displayName: "Layout",
			items: [
				{
					type: "slider",
					key: "columnWidth",
					displayName: "Column width",
					default: 200,
					min: 80,
					max: 600,
					step: 10,
					instant: true,
				},
				{
					type: "slider",
					key: "gap",
					displayName: "Gap",
					default: 8,
					min: 0,
					max: 24,
					step: 2,
					instant: true,
				},
				{
					type: "toggle",
					key: "showFilename",
					displayName: "Show filename",
					default: true,
				},
				{
					type: "toggle",
					key: "showProperties",
					displayName: "Show properties",
					default: false,
				},
			],
		},
		{
			type: "group",
			displayName: "Search",
			items: [
				{
					type: "text",
					key: "searchQuery",
					displayName: "Search",
					default: "",
					placeholder: "Filter by name or path…",
					instant: true,
				},
			],
		},
		{
			type: "group",
			displayName: "Media Filters",
			items: [
				{
					type: "dropdown",
					key: "filterShape",
					displayName: "Shape",
					default: "",
					options: {
						"": "Any",
						"square": "Square",
						"horizontal": "Horizontal",
						"vertical": "Vertical",
					},
				},
				{
					type: "dropdown",
					key: "filterColorMode",
					displayName: "Colour Filter Mode",
					default: "include",
					options: {
						"include": "Contains Color",
						"exclude": "Excludes Color",
						"colorful": "Colorful Only (Exclude B&W)",
						"grayscale": "Grayscale Only (B&W)"
					}
				},
				{
					type: "dropdown",
					key: "filterColorPreset",
					displayName: "Colour Preset",
					default: "",
					options: {
						"": "Custom Hex / Any",
						"red": "Red",
						"orange": "Orange",
						"yellow": "Yellow",
						"green": "Green",
						"blue": "Blue",
						"purple": "Purple",
						"pink": "Pink",
						"brown": "Brown",
						"black": "Black",
						"white": "White",
						"gray": "Gray"
					}
				},
				{
					type: "text",
					key: "filterColor",
					displayName: "Colour (custom hex)",
					default: "",
					placeholder: "#ff0000",
				},
				{
					type: "slider",
					key: "colorThreshold",
					displayName: "Colour proximity (%)",
					default: 50,
					min: 1,
					max: 100,
					step: 1,
				},
				{
					type: "text",
					key: "filterMinWidth",
					displayName: "Min width (px)",
					default: "",
					placeholder: "0",
				},
				{
					type: "text",
					key: "filterMaxWidth",
					displayName: "Max width (px)",
					default: "",
					placeholder: "0",
				},
				{
					type: "text",
					key: "filterMinHeight",
					displayName: "Min height (px)",
					default: "",
					placeholder: "0",
				},
				{
					type: "text",
					key: "filterMaxHeight",
					displayName: "Max height (px)",
					default: "",
					placeholder: "0",
				},
			],
		},
	];
}
