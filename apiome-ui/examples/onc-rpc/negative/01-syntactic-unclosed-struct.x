/* Sensor registry — RPCL type definitions. */
enum sensor_kind {
    SENSOR_TEMP = 0,
    SENSOR_HUMIDITY = 1
};

struct sensor_reading {
    sensor_kind kind;
    hyper value;
    string unit<16>;
