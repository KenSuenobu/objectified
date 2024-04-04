import React, {useState} from "react";
import {Accordion, AccordionDetails, AccordionSummary, Typography} from "@mui/material";
import {ExpandMoreOutlined} from "@mui/icons-material";

export interface InstanceSectionProps {
  classId: number;
  name: string;
  description: string;
}

const InstanceSection = (props: InstanceSectionProps) => {
  const [open, setOpen] = useState(false);


  const handleAccordionChange = () => (event: React.SyntheticEvent, expanded: boolean) => {
    console.log(`Panel: ${props.classId} expanded=${expanded}`);

    if (expanded) {
      // reloadPropertiesList();
    }
  }

  return (
    <>
      <Accordion onChange={handleAccordionChange()}>
        <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
          <Typography>
            <b>{props.name}</b> ({props.description})
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          {/*{classPropertiesList()}*/}
        </AccordionDetails>
      </Accordion>
    </>
  );
}

export default InstanceSection;
