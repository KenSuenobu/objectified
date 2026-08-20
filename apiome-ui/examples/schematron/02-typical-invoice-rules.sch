<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <title>Invoice business rules</title>

  <ns prefix="inv" uri="http://example.com/invoicing"/>

  <let name="allowedCurrencies" value="('EUR', 'GBP', 'USD')"/>

  <pattern id="totals">
    <title>Monetary totals must agree</title>
    <rule context="inv:Invoice">
      <let name="lineSum" value="sum(inv:Line/inv:LineAmount)"/>
      <assert test="inv:Total = $lineSum" id="INV-R001" role="error"
              flag="fatal">
        The invoice total must equal the sum of its line amounts.
      </assert>
      <assert test="inv:Currency = $allowedCurrencies" id="INV-R002" role="error">
        Currency must be one of EUR, GBP or USD.
      </assert>
      <report test="inv:Total &lt; 0" id="INV-R003" role="warning">
        A negative invoice total usually means a credit note was issued as an invoice.
      </report>
    </rule>
  </pattern>

  <pattern id="parties">
    <rule context="inv:Party[@role = 'seller']">
      <assert test="inv:TaxId" id="INV-R010" role="error">
        A seller party must declare a tax identifier.
      </assert>
      <assert test="string-length(inv:Country) = 2" id="INV-R011" role="error">
        Country must be a two-letter ISO 3166-1 code.
      </assert>
    </rule>
    <rule context="inv:Party[@role = 'buyer']">
      <assert test="inv:Name" id="INV-R012" role="error">
        A buyer party must have a name.
      </assert>
      <report test="not(inv:TaxId)" id="INV-R013" role="info">
        Buyer tax identifier is absent; some jurisdictions require it.
      </report>
    </rule>
  </pattern>

  <pattern id="dates">
    <rule context="inv:Invoice">
      <assert test="inv:IssueDate castable as xs:date" id="INV-R020" role="error">
        Issue date must be a valid xs:date.
      </assert>
      <assert test="not(inv:DueDate) or inv:DueDate >= inv:IssueDate"
              id="INV-R021" role="error">
        Due date must not precede the issue date.
      </assert>
    </rule>
  </pattern>
</schema>
