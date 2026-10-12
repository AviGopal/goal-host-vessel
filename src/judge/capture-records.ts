// JUDGE AND ROUTING CAPTURE RECORDS: a re-export. The canonical definitions live in src/judge/records.ts (one
// file for the replay records the judge entries read and the capture records goal-host writes); the names here
// are the ones capture.ts was written against. schema 1.
export type {
  JudgeEntry,
  JudgeSurface,
  RoutingEntry,
  Json,
  RecordedLlmJudge,
  RecordedPorts,
  JudgeInputRecord,
  RoutingResolution,
  RoutingInputRecord,
  JudgeCaptureMetadata,
  CaptureTruncation,
  CaptureTarget,
  CapturedReachGateEvidence as ReachGateEvidence,
  CapturedReachGateInput as ReachGateInput,
  CapturedFloorVerdictInput as FloorVerdictInput,
  CapturedFloorShortcutInput as FloorShortcutInput,
  CapturedReframeAcceptInput as ReframeAcceptInput,
  CapturedCreditOnHollowInput as CreditOnHollowInput,
} from "./records";
