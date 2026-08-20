# Battery state as a mobile robot publishes it.

# Constants become canonical enum members.
uint8 POWER_SUPPLY_STATUS_UNKNOWN=0
uint8 POWER_SUPPLY_STATUS_CHARGING=1
uint8 POWER_SUPPLY_STATUS_DISCHARGING=2
uint8 POWER_SUPPLY_STATUS_FULL=4

uint8 POWER_SUPPLY_HEALTH_GOOD=1
uint8 POWER_SUPPLY_HEALTH_OVERHEAT=2
uint8 POWER_SUPPLY_HEALTH_DEAD=3

std_msgs/Header header

float32 voltage                 # Volts
float32 temperature             # Degrees Celsius
float32 current                 # Amperes, negative when discharging
float32 charge                  # Ampere-hours
float32 capacity                # Ampere-hours
float32 percentage              # 0.0 to 1.0

uint8 power_supply_status
uint8 power_supply_health

bool present

float32[] cell_voltage          # Unbounded array, one entry per cell
float32[] cell_temperature

string location
string serial_number
