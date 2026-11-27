export class InventoryDomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ItemDefinitionInvalidError extends InventoryDomainError {
  constructor(message: string) {
    super("ITEM_DEFINITION_INVALID", message);
  }
}

export class ItemDefinitionNotFoundError extends InventoryDomainError {
  constructor(definitionCode: string, version?: number) {
    super(
      "ITEM_DEFINITION_NOT_FOUND",
      `Item definition '${definitionCode}'${version !== undefined ? ` (v${version})` : ""} does not exist or is disabled.`,
    );
  }
}

export class ItemGenerationInvalidError extends InventoryDomainError {
  constructor(message: string) {
    super("ITEM_GENERATION_INVALID", message);
  }
}

export class ItemInstanceNotFoundError extends InventoryDomainError {
  constructor(instanceId: string) {
    super("ITEM_INSTANCE_NOT_FOUND", `Item instance '${instanceId}' does not exist.`);
  }
}

export class ItemOwnershipForbiddenError extends InventoryDomainError {
  constructor(message: string) {
    super("ITEM_OWNERSHIP_FORBIDDEN", message);
  }
}

export class ItemBindingViolationError extends InventoryDomainError {
  constructor(message: string) {
    super("ITEM_BINDING_VIOLATION", message);
  }
}

export class InventoryContainerNotFoundError extends InventoryDomainError {
  constructor(containerId: string) {
    super("INVENTORY_CONTAINER_NOT_FOUND", `Inventory container '${containerId}' does not exist.`);
  }
}

export class InventoryCapacityExceededError extends InventoryDomainError {
  constructor(message: string) {
    super("INVENTORY_CAPACITY_EXCEEDED", message);
  }
}

export class InventorySlotOccupiedError extends InventoryDomainError {
  constructor(containerId: string, slotIndex: number) {
    super(
      "INVENTORY_SLOT_OCCUPIED",
      `Slot ${slotIndex} in container '${containerId}' is already occupied.`,
    );
  }
}

export class StackOperationInvalidError extends InventoryDomainError {
  constructor(message: string) {
    super("STACK_OPERATION_INVALID", message);
  }
}

export class StackIncompatibilityError extends InventoryDomainError {
  constructor(message: string) {
    super("STACK_INCOMPATIBLE", message);
  }
}

export class EquipmentSlotIncompatibleError extends InventoryDomainError {
  constructor(message: string) {
    super("EQUIPMENT_SLOT_INCOMPATIBLE", message);
  }
}

export class EquipmentRequirementNotMetError extends InventoryDomainError {
  constructor(message: string) {
    super("EQUIPMENT_REQUIREMENT_NOT_MET", message);
  }
}

export class EquipmentVersionConflictError extends InventoryDomainError {
  public readonly expectedVersion: number;
  public readonly actualVersion: number;

  constructor(entityLabel: string, expectedVersion: number, actualVersion: number) {
    super(
      "EQUIPMENT_VERSION_CONFLICT",
      `${entityLabel} version mismatch: expected ${expectedVersion}, actual ${actualVersion}.`,
    );
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class LoadoutInvalidError extends InventoryDomainError {
  constructor(message: string) {
    super("LOADOUT_INVALID", message);
  }
}

export class LoadoutLimitReachedError extends InventoryDomainError {
  constructor(characterId: string, maxLoadouts: number) {
    super(
      "LOADOUT_LIMIT_REACHED",
      `Character '${characterId}' has reached the maximum of ${maxLoadouts} equipment loadouts.`,
    );
  }
}

export class DurabilityOperationInvalidError extends InventoryDomainError {
  constructor(message: string) {
    super("DURABILITY_OPERATION_INVALID", message);
  }
}
