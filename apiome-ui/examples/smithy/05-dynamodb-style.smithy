$version: "2.0"

// Smithy 2.0 real-world example — a hand-authored reconstruction of the shape
// of the Amazon DynamoDB data-plane API (PutItem / GetItem / Query subset).
// No third-party text copied; names follow the public API surface only.

namespace example.dynamodb

service DynamoDbLike {
    version: "2026-01-01"
    operations: [PutItem, GetItem, Query]
}

/// Store an item in a table, replacing any existing item with the same key.
operation PutItem {
    input: PutItemInput
    output: PutItemOutput
}

/// Fetch a single item by its primary key.
operation GetItem {
    input: GetItemInput
    output: GetItemOutput
}

/// Query items sharing a partition key.
operation Query {
    input: QueryInput
    output: QueryOutput
}

structure PutItemInput {
    @required
    tableName: String

    @required
    item: AttributeMap
}

structure PutItemOutput {
    consumedCapacityUnits: Double
}

structure GetItemInput {
    @required
    tableName: String

    @required
    key: AttributeMap

    consistentRead: Boolean
}

structure GetItemOutput {
    item: AttributeMap
}

structure QueryInput {
    @required
    tableName: String

    @required
    keyConditionExpression: String

    expressionValues: AttributeMap
    limit: Integer
    scanIndexForward: Boolean
}

structure QueryOutput {
    items: ItemList
    count: Integer
    lastEvaluatedKey: AttributeMap
}

list ItemList {
    member: AttributeMap
}

map AttributeMap {
    key: String
    value: AttributeValue
}

/// A single DynamoDB-style attribute value; exactly one member is set.
union AttributeValue {
    s: String
    n: String
    boolValue: Boolean
}
