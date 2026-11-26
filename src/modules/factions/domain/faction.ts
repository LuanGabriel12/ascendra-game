export interface Faction {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isPlayable: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateFactionInput {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isPlayable?: boolean | undefined;
}
