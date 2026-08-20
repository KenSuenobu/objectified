# Every field form the ROS 2 .msg grammar admits.

# --- constants, one per primitive family
bool     FLAG_ENABLED=true
byte     BYTE_CONST=7
int8     INT8_CONST=-8
uint8    UINT8_CONST=8
int16    INT16_CONST=-16
uint16   UINT16_CONST=16
int32    INT32_CONST=-32
uint32   UINT32_CONST=32
int64    INT64_CONST=-64
uint64   UINT64_CONST=64
float32  FLOAT32_CONST=3.5
float64  FLOAT64_CONST=2.718281828
string   STRING_CONST="constant text"

# --- plain fields
bool     flag
byte     raw_byte
char     legacy_char
int8     small_signed
uint8    small_unsigned
int16     medium_signed
uint16    medium_unsigned
int32     signed
uint32    unsigned
int64     big_signed
uint64    big_unsigned
float32   single
float64   double_precision
string    text
wstring   wide_text

# --- bounded string and bounded wstring
string<=32   bounded_text
wstring<=16  bounded_wide

# --- arrays: unbounded, fixed-size and bounded
float64[]      unbounded_array
float64[3]     fixed_array
float64[<=10]  bounded_array
string<=8[<=4] bounded_array_of_bounded_strings

# --- defaults
int32   with_default 42
string  text_with_default "hello"
bool[3] array_with_default [true, false, true]

# --- nested and cross-package message references
std_msgs/Header                header
geometry_msgs/Pose             pose
geometry_msgs/Point[]          waypoints
sensor_msgs/RegionOfInterest   roi

# --- a field whose type is defined in this package
DiagnosticEntry[] diagnostics
