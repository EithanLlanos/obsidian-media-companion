import MediaFile from "src/model/mediaFile";
import type { App, TFile } from "obsidian";
import { extractColors } from "extract-colors";
import type MediaCompanion from "main";

export default class MCVideo extends MediaFile {
	public static size_tag = "MC-size";
	public static colors_tag = "MC-colors";

	protected constructor() { super(); }

	public static async create(file: TFile, app: App, plugin: MediaCompanion, sidecar: TFile | null = null): Promise<MCVideo> {
		const f = new MCVideo();
		await MCVideo.fill(f, file, app, plugin, sidecar);
		return f;
	}

	protected static async fill(f: MCVideo, file: TFile, app: App, plugin: MediaCompanion, sidecar: TFile | null = null) {
		await super.fill(f, file, app, plugin, sidecar);
	}

	private async extractVideoData(): Promise<{size: {width: number, height: number}, colors: {h: number, s: number, l: number, area: number}[]}> {
		return new Promise((resolve, reject) => {
			const video = document.createElement("video");
			video.muted = true;
			video.preload = "metadata";

			const resourcePath = this.app.vault.getResourcePath(this.file);
			
			// Failsafe timeout in case video loading hangs
			const timeoutId = setTimeout(() => {
				video.src = "";
				video.remove();
				reject(new Error("Video extraction timed out"));
			}, 5000);
			
			const onReady = async () => {
				clearTimeout(timeoutId);
				try {
					const canvas = document.createElement("canvas");
					canvas.width = video.videoWidth;
					canvas.height = video.videoHeight;
					const ctx = canvas.getContext("2d");
					
					if (!ctx) {
						reject(new Error("No canvas context"));
						return;
					}
					
					// Draw the current frame
					ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
					
					// Convert to Data URL to pass to extract-colors
					const dataUrl = canvas.toDataURL("image/png");
					
					const extracted = await extractColors(dataUrl, { pixels: 64000 });
					const colors = extracted.map((e: any) => ({ h: e.hue, s: e.saturation, l: e.lightness, area: e.area }));
					
					resolve({
						size: { width: canvas.width, height: canvas.height },
						colors
					});
				} catch (e) {
					console.error("Error extracting video data:", e);
					reject(e);
				} finally {
					video.src = "";
					video.remove();
				}
			};

			video.addEventListener("loadeddata", () => {
				// Seek to 0.1s to avoid extracting a purely black first frame
				video.currentTime = 0.1;
			});
			
			video.addEventListener("seeked", () => {
				onReady();
			});

			video.addEventListener("error", (e) => {
				clearTimeout(timeoutId);
				console.error("Video load error in MCVideo", e);
				reject(new Error("Video load failed"));
			});

			video.src = resourcePath;
		});
	}

	public async getCachedData(): Promise<void> {
		const colorsValue = this.sidecar.getFrontmatterTag(MCVideo.colors_tag);
		const sizeValue = this.sidecar.getFrontmatterTag(MCVideo.size_tag);

		if (!colorsValue || !MCVideo.parseSize(sizeValue)) {
			await this.extractAndSaveData();
		}
	}

	private async extractAndSaveData() {
		try {
			const data = await this.extractVideoData();
			
			await this.app.fileManager.processFrontMatter(this.sidecar.file, (fm) => {
				fm[MCVideo.colors_tag] = data.colors;
				fm[MCVideo.size_tag] = [data.size.width, data.size.height];
			});
		} catch (e) {
			console.error("Failed to extract data for video", this.file.path, e);
		}
	}

	private static parseSize(size: unknown): { width: number, height: number } | undefined {
		if (!(size instanceof Array)) return undefined;
		if (size.length !== 2) return undefined;
		return { width: size[0], height: size[1] };
	}

	public async update() { 
		const last_updated = this.sidecar.getFrontmatterTag(MediaFile.last_updated_tag) as number;

		await this.getCachedData(); 

		if (!last_updated || last_updated < this.file.stat.mtime) {
			await this.extractAndSaveData();
		}

		await super.update();
	}
}
