# Within-document composition is expressed by *referencing* other interfaces, so this
# message composes four of them: a header, two same-package types, and a cross-package
# type, plus arrays of a composed type.

std_msgs/Header header

# Same-package references, resolved by bare name.
PalletStatus pallet
LoadCell primary_cell
LoadCell[] all_cells

# Cross-package references.
geometry_msgs/Pose            pose
geometry_msgs/TwistWithCovariance velocity
builtin_interfaces/Duration   dwell_time

# Bounded array of a composed type: the composition repeats.
PalletStatus[<=8] neighbours

# Constants that classify the composed record.
uint8 KIND_SINGLE=0
uint8 KIND_STACKED=1
uint8 KIND_MIXED=2
uint8 kind

float32 total_mass_kg
string  location_hint
