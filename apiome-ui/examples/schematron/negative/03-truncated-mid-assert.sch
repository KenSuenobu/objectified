<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <ns prefix="inv" uri="http://example.com/invoicing"/>
  <pattern id="totals">
    <rule context="inv:Invoice">
      <let name="lineSum" value="sum(inv:Line/inv:LineAmount)"/>
      <assert test="inv:Total = $lineSum" id="INV-R001" role="err
