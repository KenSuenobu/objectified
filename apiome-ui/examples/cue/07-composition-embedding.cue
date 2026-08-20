// Within-document composition: definitions built from other definitions by embedding
// and unification, plus a closed base extended into two specialisations.
package composition

#Timestamps: {
	createdAt: string
	updatedAt?: string
}

#Identified: {
	id: string & =~"^[A-Z]{3}-[0-9]{6}$"
}

// Embedding: the two blocks above become part of every record.
#Record: {
	#Identified
	#Timestamps
	label: string
}

// Unification narrows an existing definition rather than restating it.
#ActiveRecord: #Record & {
	status: "active"
	updatedAt: string
}

#ArchivedRecord: #Record & {
	status:     "archived"
	archivedAt: string
}

// A disjunction over the two specialisations: the canonical union.
#AnyRecord: #ActiveRecord | #ArchivedRecord

// Composition through a pattern constraint: every value in the map must satisfy #Record.
#RecordSet: {
	[Name=string]: #Record & {label: Name}
}
