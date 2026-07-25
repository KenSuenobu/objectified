// Apache Thrift IDL example — minimal document.
//
// The smallest canonical Thrift file: a namespace declaration and a single
// struct with one required field.
namespace java com.example.ping

struct Ping {
  1: required string message,
}
