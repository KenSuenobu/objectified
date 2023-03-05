import { NextPage } from "next";
import {
  Button, Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle, FormControl, FormControlLabel, InputLabel, Select, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow,
  TextField,
  Typography
} from '@mui/material';
import {Box, Stack} from '@mui/system';
import {StackItem} from '../../components/StackItem';
import {CheckBox, CheckBoxOutlineBlank, Delete} from '@mui/icons-material';
import React, {useEffect, useRef, useState} from 'react';
import axios from 'axios';
import LoadingMessage from '../../components/LoadingMessage';
import MenuItem from '@mui/material/MenuItem';
import {errorDialog} from '../../components/dialogs/ConfirmDialog';

const DataTypes: NextPage = () => {
  const [loading, setLoading] = useState(true);
  const [dataTypes, setDataTypes] = useState([]);
  const [addDataTypeShowing, setAddDataTypeShowing] = useState(false);
  const nameRef = useRef<HTMLInputElement>();
  const descriptionRef = useRef<HTMLInputElement>();
  const maxLengthRef = useRef<HTMLInputElement>();
  const patternRef = useRef<HTMLInputElement>();
  const enumValuesRef = useRef<HTMLInputElement>();
  const enumDescriptionsRef = useRef<HTMLInputElement>();
  const examplesRef = useRef<HTMLInputElement>();

  const reloadDataTypes = () => {
    setLoading(true);
    axios.get('/app/data-types/list')
      .then((result) => {
        setDataTypes(result.data);
        setLoading(false);
      });
  }

  const addDataTypeClicked = () => {
    console.log('Clicked');
    setAddDataTypeShowing(true);
  }

  const validate = () => {
    errorDialog('Missing value.');
    return false;
  }

  const addDataType = () => {
    if (validate()) {
      const name = nameRef.current?.value ?? '';
      const description = descriptionRef.current?.value ?? '';
      const maxLength = maxLengthRef.current?.value ?? '0';
      const pattern = patternRef.current?.value ?? '';
      const enumValues = enumValuesRef.current?.value ?? '';
      const enumDescriptions = enumDescriptionsRef.current?.value ?? '';
      const examples = examplesRef.current?.value ?? '';
      
    }
  }

  useEffect(() => {
    reloadDataTypes();
  }, []);

  if (loading) {
    return (
      <LoadingMessage label={'Retrieving data types list, one moment ...'} />
    );
  }

  return (
    <>
      <div sx={{ width: '100%' }} style={{ border: '1px solid #ddd' }}>
        <Dialog open={addDataTypeShowing} fullWidth>
          <DialogTitle>Data Type</DialogTitle>
          <DialogContent>
            <Stack direction={'column'}>

              <StackItem sx={{ width: '100%' }}>
                <TextField id={'name'} label={'Name'} variant={'outlined'} required
                           fullWidth inputRef={nameRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                <TextField id={'description'} label={'Description'} variant={'outlined'}
                           required fullWidth inputRef={descriptionRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                <Stack direction={'row'}>
                  <StackItem sx={{ width: '20%' }}>
                    <FormControlLabel control={<Checkbox/>} label={'Array of: '}/>
                  </StackItem>

                  <StackItem sx={{ width: '80%' }}>
                    <FormControl fullWidth>
                      <InputLabel id={'data-type-label'}>Data Type</InputLabel>
                      <Select labelId={'data-type-label'} id={'data_type'} label={'Data Type'}>
                        <MenuItem>STRING</MenuItem>
                        <MenuItem>INT32</MenuItem>
                        <MenuItem>INT64</MenuItem>
                        <MenuItem>FLOAT</MenuItem>
                        <MenuItem>DOUBLE</MenuItem>
                        <MenuItem>BOOLEAN</MenuItem>
                        <MenuItem>DATE</MenuItem>
                        <MenuItem>DATE_TIME</MenuItem>
                        <MenuItem>BYTE</MenuItem>
                        <MenuItem>BINARY</MenuItem>
                        <MenuItem>PASSWORD</MenuItem>
                        <MenuItem>OBJECT</MenuItem>
                      </Select>
                    </FormControl>
                  </StackItem>
                </Stack>
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                <TextField id={'max_length'} label={'Maximum Input Length'} variant={'outlined'}
                           required fullWidth inputRef={maxLengthRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                <TextField id={'pattern'} label={'Regexp Pattern'} variant={'outlined'}
                           required fullWidth inputRef={patternRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                <TextField id={'enum_values'} label={'Enumeration Values'} variant={'outlined'}
                           required fullWidth inputRef={enumValuesRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                <TextField id={'enum_descriptions'} label={'Enumeration Descriptions'} variant={'outlined'}
                           required fullWidth inputRef={enumDescriptionsRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                <TextField id={'examples'} label={'Examples'} variant={'outlined'}
                           required fullWidth inputRef={examplesRef}/>
              </StackItem>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => addDataType()} variant={'contained'}>Add</Button>
            <Button onClick={() => setAddDataTypeShowing(false)} variant={'contained'} color={'error'}>Cancel</Button>
          </DialogActions>
        </Dialog>

        <Stack direction={'row'}>
          <StackItem sx={{ width: '100%', textAlign: 'left', backgroundColor: '#ddd' }}>
            <Typography fontWeight={'bold'} sx={{ color: 'black', verticalAlign: 'middle', padding: '1em' }}>
              Data Types
            </Typography>
          </StackItem>
        </Stack>

        <Stack direction={'row'}>
          <StackItem sx={{ width: '100%', padding: '1em', color: '#000' }}>
            <Typography>
              Data Types define the types of data that can be stored in Objectified.
            </Typography>
          </StackItem>
          <StackItem sx={{ textAlign: 'right', padding: '1em', width: '10%' }}>
            <Button onClick={() => addDataTypeClicked()} variant={'outlined'}>Add</Button>
          </StackItem>
        </Stack>

        <TableContainer component={Box}>
          <Table sx={{ minWidth: 650, backgroundColor: '#fff' }} aria-label={'datatype table'}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 'bold' }}>ID</TableCell>
                <TableCell sx={{ fontWeight: 'bold' }}>Name</TableCell>
                <TableCell sx={{ fontWeight: 'bold' }}>Description</TableCell>
                <TableCell sx={{ fontWeight: 'bold' }}>Type</TableCell>
                <TableCell sx={{ fontWeight: 'bold', textAlign: 'center' }}>Enabled</TableCell>
                <TableCell sx={{ fontWeight: 'bold' }}>Create Date</TableCell>
                <TableCell sx={{ fontWeight: 'bold' }}>Update Date</TableCell>
                <TableCell></TableCell>
              </TableRow>
            </TableHead>
            {dataTypes.map((row) => (
              <TableRow hover>
                <TableCell sx={{ color: '#000' }}>{row.id}</TableCell>
                <TableCell sx={{ color: '#000' }}>{row.name}</TableCell>
                <TableCell sx={{ color: '#000' }}>{row.description}</TableCell>
                <TableCell sx={{ color: '#000' }}>{row.data_type}</TableCell>
                <TableCell sx={{ color: '#000', textAlign: 'center' }}>{row.enabled ? <CheckBox/> : <CheckBoxOutlineBlank/>}</TableCell>
                <TableCell sx={{ color: '#000' }}>{row.create_date}</TableCell>
                <TableCell sx={{ color: '#000' }}>{row.update_date}</TableCell>
                <TableCell align={'right'}>{row.core_type ? (<></>) : (<Delete sx={{ color: 'red' }}/>)}</TableCell>
              </TableRow>
            ))}
          </Table>
        </TableContainer>
      </div>
    </>
  );
}

export default DataTypes;
