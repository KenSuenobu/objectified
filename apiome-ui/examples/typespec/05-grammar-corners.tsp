// TypeSpec stress example — the grammar's less common corners in one file:
// @header / @query / @body parameter decorators, patch and delete verbs,
// optional fields, numeric and boolean scalars, arrays, and doc comments.
import "@typespec/http";
import "@typespec/rest";

using TypeSpec.Http;
using TypeSpec.Rest;

@service(#{ title: "Device Fleet API" })
namespace DeviceFleet;

/// Operational state reported by a device.
enum DeviceState {
  provisioning,
  online,
  offline,
  retired,
}

/// A managed device in the fleet.
model Device {
  @key id: string;
  serialNumber: string;
  state: DeviceState;
  firmwareVersion?: string;
  batteryPercent?: int32;
  tags: string[];
  lastSeen?: utcDateTime;
  shadowEnabled: boolean;
}

/// Sparse update payload; every field is optional.
model DevicePatch {
  state?: DeviceState;
  firmwareVersion?: string;
  shadowEnabled?: boolean;
}

/// A firmware rollout request body.
model RolloutRequest {
  targetVersion: string;
  maxFailuresPercent: float32;
  dryRun: boolean;
}

/// Summary returned by the rollout endpoint.
model RolloutSummary {
  rolloutId: string;
  deviceCount: int64;
}

@route("/devices")
interface Devices {
  /// List devices, filtered by state and paged with a query cursor.
  @get list(@query state: string, @query cursor: string): Device[];

  /// Fetch one device; supports conditional reads via an entity-tag header.
  @get read(@path id: string, @header ifNoneMatch: string): Device;

  /// Apply a sparse update to a device.
  @patch update(@path id: string, @body patch: DevicePatch): Device;

  /// Decommission a device.
  @delete remove(@path id: string): void;
}

@route("/rollouts")
interface Rollouts {
  /// Start a firmware rollout across the fleet.
  @post create(@body request: RolloutRequest): RolloutSummary;
}
