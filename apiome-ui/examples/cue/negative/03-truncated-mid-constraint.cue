package orders

#OrderLine: {
	sku:      string & =~"^[A-Z]{3}-[0-9]{4}$"
	quantity: int & >0 & <=99
