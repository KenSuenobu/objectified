package orders

// Every field is a type, not a value: `cue export` refuses an incomplete configuration,
// so the evaluation the importer depends on produces no JSON at all.
#Order: {
	orderId:    string
	customerId: string
	total:      number
}

order: #Order
