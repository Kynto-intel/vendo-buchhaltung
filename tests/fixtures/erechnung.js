'use strict'
// Erfundene E-Rechnungen (CII und UBL) für die Tests zu erechnung.js (K.3). Keine echten Firmen oder Beträge.
const CII = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocument><ram:ID>SYN-2026-001</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime><udt:DateTimeString format="102">20260315</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem><ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument></ram:IncludedSupplyChainTradeLineItem>
    <ram:IncludedSupplyChainTradeLineItem><ram:AssociatedDocumentLineDocument><ram:LineID>2</ram:LineID></ram:AssociatedDocumentLineDocument></ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement><ram:SellerTradeParty><ram:Name>Erfundene Druckerei GmbH &amp; Co. KG</ram:Name><ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE000000000</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty><ram:BuyerTradeParty><ram:Name>Synthetik-Shop</ram:Name></ram:BuyerTradeParty></ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>100.00</ram:LineTotalAmount><ram:TaxBasisTotalAmount>100.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">19.00</ram:TaxTotalAmount><ram:GrandTotalAmount>119.00</ram:GrandTotalAmount><ram:DuePayableAmount>119.00</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`

const UBL = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>SYN-UBL-7</cbc:ID><cbc:IssueDate>2026-02-01</cbc:IssueDate><cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Erfundene Software Ltd</cbc:Name></cac:PartyName><cac:PartyLegalEntity><cbc:RegistrationName>Erfundene Software Ltd</cbc:RegistrationName></cac:PartyLegalEntity><cbc:ID>SOLL-NICHT-DIE-NUMMER-SEIN</cbc:ID></cac:Party></cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount><cac:TaxSubtotal><cac:TaxCategory><cbc:ID>AE</cbc:ID></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="EUR">50.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">50.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">50.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID></cac:InvoiceLine>
</Invoice>`

module.exports = { CII, UBL }
