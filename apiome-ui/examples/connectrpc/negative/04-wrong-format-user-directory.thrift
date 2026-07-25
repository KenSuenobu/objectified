// Apache Thrift IDL — user directory service used to exercise
// wrong-format rejection in a protobuf-based importer.
namespace java com.example.users

struct User {
  1: required i64 id,
  2: optional string display_name,
  3: optional string email
}

exception UserNotFound {
  1: string message
}

service UserDirectory {
  User fetch(1: i64 id) throws (1: UserNotFound not_found),
  list<User> search(1: string query)
}
