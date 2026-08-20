<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/">
    <report>
      <xsl:for-each select="//invoice">
        <line><xsl:value-of select="@number"/></line>
      </xsl:for-each>
    </report>
  </xsl:template>
</xsl:stylesheet>
