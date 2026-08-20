// './missing-module' is not present in the fileset, so `SharedAddress` can never be
// resolved. The import must report a named unresolved reference rather than modelling
// the field as `any`.
import type { SharedAddress } from './missing-module';

export interface Shipment {
  shipmentId: string;
  destination: SharedAddress;
  weightKg: number;
}
