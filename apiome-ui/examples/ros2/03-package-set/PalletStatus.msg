# Root message of the package: references a sibling message and a cross-package type.
std_msgs/Header header

string pallet_id
uint8 STATE_EMPTY=0
uint8 STATE_LOADED=1
uint8 STATE_IN_TRANSIT=2
uint8 state

geometry_msgs/Pose pose
LoadCell[] load_cells
float32 total_mass_kg
