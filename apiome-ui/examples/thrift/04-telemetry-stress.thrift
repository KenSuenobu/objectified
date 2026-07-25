// Apache Thrift IDL example — stress: union, exception, oneway methods,
// nested containers, i8/i16/binary scalars, hex enum values, defaults, and
// multiple language namespaces.
namespace java com.example.telemetry
namespace py example.telemetry
namespace go example.telemetry

typedef map<string, list<double>> SeriesBySensor;
typedef set<string> Tags;

enum Severity {
  DEBUG = 0x10,
  INFO = 0x20,
  WARN = 0x30,
  ERROR = 0x40,
}

// A tagged value: exactly one member is set.
union Value {
  1: bool flag,
  2: i64 count,
  3: double gauge,
  4: string label,
  5: binary blob,
}

struct Sample {
  1: required string sensorId,
  2: required i64 timestamp,
  3: Value value,
  4: Tags tags,
  5: Severity severity = Severity.INFO,
  6: optional map<string, string> annotations,
  7: i8 flagsByte,
  8: i16 shortCode,
}

struct Window {
  1: SeriesBySensor series,
  2: list<set<i32>> buckets,
  3: map<i32, map<string, double>> nested,
}

exception Overloaded {
  1: string message,
  2: i32 retryAfterSeconds,
}

service Telemetry {
  // Fire-and-forget ingestion.
  oneway void record(
    1: Sample sample
  ),

  Window aggregate(
    1: string sensorId
  ) throws (1: Overloaded o),

  void flush(),
}
