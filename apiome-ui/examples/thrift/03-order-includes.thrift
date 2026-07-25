// Apache Thrift IDL example — composition: include, typedef chains, and
// cross-file type references.
//
// `include "shared.thrift"` pulls another IDL file into scope; its types are
// referenced with the `shared.` prefix. Typedefs layer on containers and on
// each other, and structs reuse those aliases.
include "shared.thrift"

namespace java com.example.orders
namespace py example.orders

typedef string OrderId;
typedef list<OrderId> OrderIdList;
typedef map<string, shared.Money> PriceBySku;

struct OrderLine {
  1: required string sku,
  2: required i32 quantity,
  3: shared.Money unitPrice,
}

struct Order {
  1: required OrderId id,
  2: required list<OrderLine> lines,
  3: optional shared.Money total,
  4: OrderIdList relatedOrders,
}

service OrderService {
  Order getOrder(
    1: OrderId id
  ),

  OrderIdList listOrders(
    1: string customerId
  ),

  PriceBySku currentPrices(
    1: string catalogId
  ),
}
