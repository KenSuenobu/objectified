package orders

#OrderLine: {
	sku:      string & =~"^[A-Z]{3}-[0-9]{4}$"
	quantity: int & >0 & <=9999
}

#Order: {
	orderId: string
	lines: [...#OrderLine]
}
