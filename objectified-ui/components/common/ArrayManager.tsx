import {StackItem} from "../StackItem";
import {Button, TextField, Typography} from "@mui/material";
import React from "react";
import {Stack} from "@mui/system";
import {AddOutlined} from "@mui/icons-material";

export interface ArrayManagerProps {
  setterCallback: any;
  header: string;
  objectArray: string[];
}

const ArrayManager = (props: ArrayManagerProps) => {
  return (
    <>
      <Stack direction={'row'}>
        <StackItem sx={{ width: '80%', textAlign: 'left', backgroundColor: '#ddd' }}>
          <Typography fontWeight={'bold'} sx={{ color: 'black', verticalAlign: 'middle', padding: '1em' }}>
            {props.header}
          </Typography>
        </StackItem>
        <StackItem sx={{ width: '20%', textAlign: 'right', backgroundColor: '#ddd', paddingRight: '1em', paddingTop: '10px'  }}>
          <Button variant={'contained'}>Add</Button>
        </StackItem>
      </Stack>
    </>
  );
}

export default ArrayManager;