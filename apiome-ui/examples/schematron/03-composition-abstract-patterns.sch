<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <title>Abstract patterns and rule extension</title>

  <ns prefix="ord" uri="http://example.com/orders"/>

  <!-- An abstract pattern is a template: it is instantiated by is-a, never applied directly. -->
  <pattern id="mandatoryChild" abstract="true">
    <rule context="$parent">
      <assert test="$child" id="ABS-R001" role="error">
        A <name/> must contain a <value-of select="'$child'"/> element.
      </assert>
    </rule>
  </pattern>

  <pattern id="orderHasLines" is-a="mandatoryChild">
    <param name="parent" value="ord:Order"/>
    <param name="child" value="ord:Line"/>
  </pattern>

  <pattern id="lineHasSku" is-a="mandatoryChild">
    <param name="parent" value="ord:Line"/>
    <param name="child" value="ord:Sku"/>
  </pattern>

  <!-- Abstract rules are extended by concrete rules with extends. -->
  <pattern id="identifiers">
    <rule abstract="true" id="identifiedThing">
      <assert test="@id" id="ID-R001" role="error">Element must carry an id attribute.</assert>
      <assert test="not(@id) or matches(@id, '^[A-Z]{3}-[0-9]{4,}$')" id="ID-R002" role="error">
        Ids follow the AAA-9999 shape.
      </assert>
    </rule>

    <rule context="ord:Order">
      <extends rule="identifiedThing"/>
      <assert test="ord:PlacedAt" id="ORD-R001" role="error">
        An order must record when it was placed.
      </assert>
    </rule>

    <rule context="ord:Shipment">
      <extends rule="identifiedThing"/>
      <assert test="ord:Carrier" id="SHP-R001" role="warning">
        A shipment without a carrier cannot be tracked.
      </assert>
    </rule>
  </pattern>
</schema>
