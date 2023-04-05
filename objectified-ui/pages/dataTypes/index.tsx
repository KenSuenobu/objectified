import { NextPage } from "next";
import {
  Button, Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle, FormControl, FormControlLabel, InputLabel, Select, SelectChangeEvent, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow,
  TextField,
  Typography
} from '@mui/material';
import {Box, Stack} from '@mui/system';
import {StackItem} from '../../components/StackItem';
import {CheckBox, CheckBoxOutlineBlank, Delete, EditOutlined} from '@mui/icons-material';
import React, {useEffect, useRef, useState} from 'react';
import axios from 'axios';
import LoadingMessage from '../../components/LoadingMessage';
import MenuItem from '@mui/material/MenuItem';
import {errorDialog} from '../../components/dialogs/ConfirmDialog';
import {loadDataTypes} from "../../components/data/dataTypes";

const DataTypes: NextPage = () => {
  const [loading, setLoading] = useState(true);
  const [dataTypes, setDataTypes] = useState([]);
  const [dataType, setDataType] = useState('');
  const [isArray, setIsArray] = useState(false);
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

    loadDataTypes(setDataTypes)
      .then(() => setLoading(false));
  }

  const addDataTypeClicked = () => {
    setAddDataTypeShowing(true);
  }

  const handleDataTypeChanged = (event: SelectChangeEvent) => {
    setDataType(event.target.value as string);
  }

  const handleIsArrayChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    setIsArray(event.target.checked);
  }

  const validate = () => {
    const name = nameRef.current?.value ?? '';
    const description = descriptionRef.current?.value ?? '';

    if (name.length === 0) {
      errorDialog('A name is required');
      return false;
    }

    if (description.length === 0) {
      errorDialog('A description is required');
      return false;
    }

    return true;
  }

  const addDataType = () => {
    if (validate()) {
      const name = nameRef.current?.value ?? '';
      const description = descriptionRef.current?.value ?? '';
      const maxLength = maxLengthRef.current?.value;
      const pattern = patternRef.current?.value ?? '';
      const enumValues = enumValuesRef.current?.value ?? '';
      const enumDescriptions = enumDescriptionsRef.current?.value ?? '';
      const examples = examplesRef.current?.value ?? '';
      const dataTypeObject: any = {};

      dataTypeObject.name = name;
      dataTypeObject.description = description;
      dataTypeObject.enabled = true;
      dataTypeObject.maxLength = maxLength.length > 0 ? parseInt(maxLength) : 0;
      dataTypeObject.isArray = isArray;
      dataTypeObject.dataType = dataType;
      dataTypeObject.pattern = pattern;
      dataTypeObject.coreType = false;

      if (enumValues.length > 0) {
        dataTypeObject.enumValues = enumValues.split(',');
      }

      if (enumDescriptions.length > 0) {
        dataTypeObject.enumDescriptions = enumDescriptions.split(',');
      }

      if (examples.length > 0) {
        dataTypeObject.examples = examples;
      }

      axios.post('/app/data-types/create', dataTypeObject)
        .then((x) => {
          setAddDataTypeShowing(false);
          reloadDataTypes();
        })
        .catch((x) => {
          errorDialog(x.message);
        });
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
            <Stack direction={'column'} sx={{ padding: '1em' }}>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'name'} label={'Name'} variant={'outlined'} required
                           fullWidth inputRef={nameRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'description'} label={'Description'} variant={'outlined'}
                           required fullWidth inputRef={descriptionRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <Stack direction={'row'}>
                  <StackItem sx={{ width: '25%', padding: '4px', verticalAlign: 'middle' }}>
                    <FormControlLabel control={<Checkbox checked={isArray} onChange={handleIsArrayChanged}/>} label={'Array of: '}/>
                  </StackItem>

                  <StackItem sx={{ width: '75%', padding: '4px' }}>
                    <FormControl fullWidth>
                      <InputLabel id={'data-type-label'} required>Data Type</InputLabel>
                      <Select labelId={'data-type-label'} id={'data_type'} label={'Data Type'}
                              onChange={handleDataTypeChanged} value={dataType}>
                        <MenuItem value={'STRING'}>STRING</MenuItem>
                        <MenuItem value={'INT32'}>INT32</MenuItem>
                        <MenuItem value={'INT64'}>INT64</MenuItem>
                        <MenuItem value={'FLOAT'}>FLOAT</MenuItem>
                        <MenuItem value={'DOUBLE'}>DOUBLE</MenuItem>
                        <MenuItem value={'BOOLEAN'}>BOOLEAN</MenuItem>
                        <MenuItem value={'DATE'}>DATE</MenuItem>
                        <MenuItem value={'DATE_TIME'}>DATE_TIME</MenuItem>
                        <MenuItem value={'BYTE'}>BYTE</MenuItem>
                        <MenuItem value={'BINARY'}>BINARY</MenuItem>
                        <MenuItem value={'PASSWORD'}>PASSWORD</MenuItem>
                        <MenuItem value={'OBJECT'}>OBJECT</MenuItem>
                      </Select>
                    </FormControl>
                  </StackItem>
                </Stack>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'max_length'} label={'Maximum Input Length'} variant={'outlined'}
                           fullWidth inputRef={maxLengthRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'pattern'} label={'Regexp Pattern'} variant={'outlined'}
                           fullWidth inputRef={patternRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'enum_values'} label={'Enumeration Values'} variant={'outlined'}
                           fullWidth inputRef={enumValuesRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'enum_descriptions'} label={'Enumeration Descriptions'} variant={'outlined'}
                           fullWidth inputRef={enumDescriptionsRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'examples'} label={'Examples'} variant={'outlined'}
                           fullWidth inputRef={examplesRef}/>
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
                <TableCell align={'right'}>{row.core_type ? (<></>) : (
                  <>
                    <EditOutlined/>&nbsp;
                    <Delete sx={{ color: 'red' }}/>
                  </>
                )}</TableCell>
              </TableRow>
            ))}
          </Table>
        </TableContainer>
      </div>
    </>
  );
}

export default DataTypes;
