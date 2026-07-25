// Thrift IDL with only namespace, typedef, and const declarations —
// grammar-valid but there is no struct, enum, or service to import.
namespace java com.example.constantsonly

typedef i64 Timestamp

const i32 MAX_RETRIES = 3
