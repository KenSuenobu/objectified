/**
 * Export Studio — the pure rules the redesigned surface reads (HIVE-8.3, #5329).
 *
 * The components themselves stay in `ade/dashboard/export/`, where five years of behaviour
 * (MFX, IXH and EFP tickets) already lives and where the ExportDialog shares half of them.
 * What moved here is only what had no home: the word → tone mappings and the target-family
 * partition, both of which were previously spelled inline as palette strings in whichever
 * component happened to need them.
 */

export {
  EXPORT_TARGET_FAMILIES,
  OTHER_FAMILY,
  familyForParadigm,
  groupTargetsByFamily,
  type ExportTargetFamily,
  type ExportTargetFamilyGroup,
} from './exportTargetFamilies';

export {
  DELIVERY_SEVERITY_TONE,
  ENTITY_KIND_TONE,
  PROJECTION_STATUS_TONE,
  VALIDATION_LENS_TONE,
  deliverySeverityTone,
  entityKindTone,
  eventLevelState,
  lensBadgeTone,
  projectionStatusTone,
  roundtripDiffTone,
  stageRowState,
  validationToneName,
  type StudioStageStatus,
} from './exportStudioView';
