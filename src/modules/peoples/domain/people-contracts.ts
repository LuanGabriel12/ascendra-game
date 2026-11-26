export interface CustomizationProfile {
  readonly profileVersion: number;
  readonly allowedBodyPresets: ReadonlyArray<string>;
  readonly allowedSkinTones: ReadonlyArray<string>;
  readonly supportsHair: boolean;
  readonly supportsBeard: boolean;
  readonly allowedEarStyles: ReadonlyArray<string>;
  readonly supportsHorns: boolean;
  readonly allowedHornStyles: ReadonlyArray<string>;
  readonly supportsTail: boolean;
  readonly allowedTailStyles: ReadonlyArray<string>;
  readonly supportsScales: boolean;
  readonly requiresScales: boolean;
  readonly allowedScalePatterns: ReadonlyArray<string>;
}

export interface PlayablePeopleDefinition {
  readonly raceCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly isPlayable: boolean;
  readonly isEnabled: boolean;
  readonly catalogVersion: number;
  readonly attributeBudgetProfile: "standard_100";
  readonly customizationProfile: CustomizationProfile;
  readonly plannedTraitsNotes: string;
}

export interface LineageDefinition {
  readonly lineageCode: string;
  readonly raceCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly isEnabled: boolean;
  readonly catalogVersion: number;
}

export interface CultureDefinition {
  readonly cultureCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly defaultRegionId: string | null;
  readonly traditions: ReadonlyArray<string>;
  readonly languages: ReadonlyArray<string>;
  readonly isEnabled: boolean;
  readonly catalogVersion: number;
}

export interface BackgroundDefinition {
  readonly backgroundCode: string;
  readonly displayName: string;
  readonly description: string;
  readonly narrativeTags: ReadonlyArray<string>;
  readonly isEnabled: boolean;
  readonly catalogVersion: number;
}
