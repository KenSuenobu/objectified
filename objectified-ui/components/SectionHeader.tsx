import {Stack} from "@mui/system";
import {StackItem} from "./StackItem";
import {Typography} from "@mui/material";
import React from "react";

export interface SectionHeaderProps {
  header: string;
}

const SectionHeader = (props: SectionHeaderProps) => {
  return (
    <>
      <Stack direction={'row'}>
        <StackItem sx={{ width: '100%', textAlign: 'left', backgroundColor: '#ddd' }}>
          <Typography fontWeight={'bold'} sx={{ color: 'black', verticalAlign: 'middle', padding: '1em' }}>
            {props.header}
          </Typography>
        </StackItem>
      </Stack>
    </>
  );
}

export default SectionHeader;