<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <title>Cross-border billing profile — business rules</title>

  <p>
    Rule pack in the shape a European e-invoicing profile publishes: numbered business
    rules (BR-nn) over a UBL-derived invoice, each with a stable id, a severity role and
    a message that names the rule number. Reconstructed from the shape of such a profile;
    no upstream text copied.
  </p>

  <ns prefix="cbc" uri="urn:example:names:specification:billing:schema:common:BasicComponents"/>
  <ns prefix="cac" uri="urn:example:names:specification:billing:schema:common:AggregateComponents"/>
  <ns prefix="ubl" uri="urn:example:names:specification:billing:schema:Invoice"/>

  <let name="profileId" value="'urn:example.com:billing:3.0'"/>

  <pattern id="BR-core">
    <title>Core invoice rules</title>

    <rule context="ubl:Invoice">
      <assert test="cbc:CustomizationID = $profileId" id="BR-01" role="fatal">
        [BR-01] An invoice shall have a specification identifier matching this profile.
      </assert>
      <assert test="cbc:ID" id="BR-02" role="fatal">
        [BR-02] An invoice shall have an invoice number.
      </assert>
      <assert test="cbc:IssueDate" id="BR-03" role="fatal">
        [BR-03] An invoice shall have an issue date.
      </assert>
      <assert test="cbc:InvoiceTypeCode" id="BR-04" role="fatal">
        [BR-04] An invoice shall have an invoice type code.
      </assert>
      <assert test="cbc:DocumentCurrencyCode" id="BR-05" role="fatal">
        [BR-05] An invoice shall have a document currency code.
      </assert>
      <assert test="cac:AccountingSupplierParty/cac:Party/cac:PartyName/cbc:Name" id="BR-06" role="fatal">
        [BR-06] An invoice shall contain the seller name.
      </assert>
      <assert test="cac:AccountingCustomerParty/cac:Party/cac:PartyName/cbc:Name" id="BR-07" role="fatal">
        [BR-07] An invoice shall contain the buyer name.
      </assert>
      <assert test="count(cac:InvoiceLine) >= 1" id="BR-16" role="fatal">
        [BR-16] An invoice shall have at least one invoice line.
      </assert>
    </rule>
  </pattern>

  <pattern id="BR-calculations">
    <title>Calculation rules</title>

    <rule context="cac:LegalMonetaryTotal">
      <let name="lineExtension" value="sum(../cac:InvoiceLine/cbc:LineExtensionAmount)"/>
      <assert test="cbc:LineExtensionAmount = $lineExtension" id="BR-CO-10" role="fatal">
        [BR-CO-10] Sum of invoice line net amounts shall equal the sum of the line amounts.
      </assert>
      <assert test="cbc:PayableAmount =
                    (cbc:TaxInclusiveAmount - (cbc:PrepaidAmount, 0)[1])"
              id="BR-CO-16" role="fatal">
        [BR-CO-16] Amount due for payment shall equal the inclusive amount less prepaid amount.
      </assert>
    </rule>

    <rule context="cac:InvoiceLine">
      <assert test="cbc:LineExtensionAmount =
                    round((cbc:InvoicedQuantity * cac:Price/cbc:PriceAmount) * 100) div 100"
              id="BR-CO-04" role="fatal">
        [BR-CO-04] Invoice line net amount shall equal quantity times item net price.
      </assert>
      <assert test="cbc:InvoicedQuantity > 0" id="BR-27" role="error">
        [BR-27] Invoiced quantity shall be greater than zero.
      </assert>
    </rule>
  </pattern>

  <pattern id="BR-vat">
    <title>VAT rules</title>

    <rule context="cac:TaxTotal/cac:TaxSubtotal">
      <assert test="cbc:TaxableAmount" id="BR-45" role="fatal">
        [BR-45] Each VAT breakdown shall have a taxable amount.
      </assert>
      <assert test="cbc:TaxAmount" id="BR-46" role="fatal">
        [BR-46] Each VAT breakdown shall have a VAT category tax amount.
      </assert>
      <assert test="cac:TaxCategory/cbc:ID = ('S','Z','E','AE','K','G','O','L','M')"
              id="BR-47" role="fatal">
        [BR-47] Each VAT breakdown shall be defined through a VAT category code.
      </assert>
      <report test="cac:TaxCategory/cbc:ID = 'E' and not(cbc:TaxExemptionReason)"
              id="BR-E-10" role="error">
        [BR-E-10] An exempt VAT breakdown shall state an exemption reason.
      </report>
    </rule>
  </pattern>
</schema>
