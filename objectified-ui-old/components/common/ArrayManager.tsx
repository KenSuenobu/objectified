import {StackItem} from "../StackItem";
import {Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography} from "@mui/material";
import React, {useRef, useState } from "react";
import {Stack} from "@mui/system";
import {AddOutlined} from "@mui/icons-material";

export interface ArrayManagerProps {
  setterCallback: any;
  header: string;
  objectArray: string[];
}

const ArrayManager = (props: ArrayManagerProps) => {
  const [open, setOpen] = useState(false);
  const itemValueRef = useRef();

  const addItem = () => {
    props.objectArray.push(itemValueRef.current.value);
    setOpen(false);
  }

  return (
    <>
      <Dialog open={open} maxWidth={'sm'} fullWidth>
        <DialogContent>
          <Stack direction={'column'}>
            <StackItem sx={{ width: '100%', padding: '4px' }}>
              <TextField id={'item_value'} label={'Item Value'} variant={'outlined'} required inputRef={itemValueRef} fullWidth/>
            </StackItem>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => addItem()} variant={'contained'}>Add</Button>
          <Button onClick={() => setOpen(false)} variant={'contained'} color={'error'}>Cancel</Button>
        </DialogActions>
      </Dialog>
w
      <Stack direction={'row'}>
        <StackItem sx={{ width: '80%', textAlign: 'left', backgroundColor: '#ddd' }}>
          <Typography fontWeight={'bold'} sx={{ color: 'black', verticalAlign: 'middle', padding: '1em' }}>
            {props.header}
          </Typography>
        </StackItem>
        <StackItem sx={{ width: '20%', textAlign: 'right', backgroundColor: '#ddd', paddingRight: '1em', paddingTop: '10px'  }}>
          <Button variant={'contained'} onClick={() => setOpen(true)}>Add</Button>
        </StackItem>
      </Stack>

      {props.objectArray.toString()}
    </>
  );
}

export default ArrayManager;