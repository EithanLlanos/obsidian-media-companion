export interface MediaCompanionSettings {
	silenceStartupNotification: boolean;
	hideSidecar: boolean;
	hideMediaFiles: boolean;
	extensions: string[];
	sidecarTemplate: string;

	apiEnabled: boolean;
	apiPort: number;
	apiKey: string;

	fullscreenMode: "off" | "hover" | "click";
	fullscreenHoverDelay: number;
}

export const DEFAULT_SETTINGS: MediaCompanionSettings = {
	silenceStartupNotification: false,
	hideSidecar: true,
	hideMediaFiles: false,
	extensions: [
		'png',
		'jpg',
		'jpeg',
		'bmp',
		'avif',
		'webp',
		'gif',
		'mp4',
		'webm',
		'ogv',
		'mov',
	],
	sidecarTemplate: "",

	apiEnabled: false,
	apiPort: 27124,
	apiKey: "",

	fullscreenMode: "hover",
	fullscreenHoverDelay: 1000,
}
