import {NextPage} from 'next';
import axios from 'axios';
import React, {useEffect, useRef, useState} from 'react';
import LoadingMessage from '../../components/LoadingMessage';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl, InputLabel, Select, SelectChangeEvent, Table, TableCell, TableContainer, TableHead, TableRow,
  TextField,
  Typography
} from '@mui/material';
import {Box, Stack} from '@mui/system';
import {StackItem} from '../../components/StackItem';
import MenuItem from '@mui/material/MenuItem';
import {errorDialog} from "../../components/dialogs/ConfirmDialog";
import {CheckBox, CheckBoxOutlineBlank, Delete} from "@mui/icons-material";
import { loadFields } from '../../components/data/fields';
import { loadDataTypes } from '../../components/data/dataTypes';
import SectionHeader from "../../components/SectionHeader";

const Fields: NextPage = () => {
  const [loading, setLoading] = useState(false);
  const [fields, setFields] = useState([]);
  const [dataTypes, setDataTypes] = useState([]);
  const [addFieldShowing, setAddFieldShowing] = useState(false);
  const [dataType, setDataType] = useState(0);
  const nameRef = useRef();
  const descriptionRef = useRef();
  const defaultValueRef = useRef();

  const reloadFields = () => {
    setLoading(true);

    loadDataTypes(setDataTypes)
      .then(() => loadFields(setFields))
      .then(() => setLoading(false));
  }

  const addFieldClicked = () => {
    setAddFieldShowing(true);
  }

  const addField = () => {
    const nameValue = nameRef?.current?.value ?? '';
    const descriptionValue = descriptionRef?.current?.value ?? '';
    const defaultValue = defaultValueRef?.current?.value ?? '';

    if (nameValue.length > 0 && descriptionValue.length > 0) {
      const field: any = {};

      field.name = nameValue;
      field.description = descriptionValue;
      field.defaultValue = defaultValue;
      field.enabled = true;
      field.dataType = {
        id: dataType,
      };

      axios.post('/app/fields/create', field)
        .then((x) => {
          setAddFieldShowing(false);
          reloadFields();
        })
        .catch((x) => {
          errorDialog(x.message);
        });
    } else if (nameValue.length > 0) {
      return errorDialog('Name is missing a value.');
    } else if (descriptionValue.length > 0) {
      return errorDialog('Description is missing a value.');
    }
  }

  const findDataType = (id: number) => {
    return dataTypes.find((x) => x.id === id);
  }

  const handleDataTypeChanged = (event: SelectChangeEvent) => {
    setDataType(event.target.value as number);
  }

  useEffect(() => {
    reloadFields();
  }, []);

  if (loading) {
    return (
      <LoadingMessage label={'Retrieving fields list, one moment ...'} />
    );
  }

  return (
    <>
      <div sx={{ width: '100%' }} style={{ border: '1px solid #ddd' }}>
        <Dialog open={addFieldShowing} maxWidth={'sm'} fullWidth>
          <DialogTitle>Field</DialogTitle>
          <DialogContent>
            <Stack direction={'column'} sx={{ padding: '1em' }}>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <FormControl fullWidth required>
                  <InputLabel id={'data-type-label'} required>Data Type</InputLabel>
                  <Select labelId={'data-type-label'} id={'data_type'} label={'Data Type'}
                          onChange={handleDataTypeChanged} value={dataType}>
                    {dataTypes.map((x) => (
                      <MenuItem value={x.id}>{x.name} ({x.description})</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'name'} label={'Name'} variant={'outlined'} required fullWidth inputRef={nameRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'description'} label={'Description'} variant={'outlined'} required fullWidth inputRef={descriptionRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'default_value'} label={'Default Value'} variant={'outlined'} fullWidth inputRef={defaultValueRef}/>
              </StackItem>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => addField()} variant={'contained'}>Add</Button>
            <Button onClick={() => setAddFieldShowing(false)} variant={'contained'} color={'error'}>Cancel</Button>
          </DialogActions>
        </Dialog>

        <SectionHeader header={'Fields'} onAdd={() => addFieldClicked()}>
          <Typography>
            Fields describe data that can be stored by a property.  Fields expand the data type definition by adding
            default values, a required field flag, and unique name and description.  Properties use field definitions
            to describe the data that an object can store.  Fields are bound and unique to each namespace.
          </Typography>
        </SectionHeader>

        <TableContainer component={Box}>
          <Table sx={{ minWidth: 650, backgroundColor: '#fff' }} aria-label={'datatype table'}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd' }}>ID</TableCell>
                <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd' }}>Name</TableCell>
                <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd' }}>Description</TableCell>
                <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd' }}>Data Type</TableCell>
                <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd', textAlign: 'center' }}>Enabled</TableCell>
                <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd' }}>Create Date</TableCell>
                <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd' }}>Update Date</TableCell>
                <TableCell sx={{ borderTop: '1px solid #ddd' }}></TableCell>
              </TableRow>
            </TableHead>
            {fields.map((row) => (
                <TableRow hover>
                  <TableCell sx={{ color: '#000' }}>{row.id}</TableCell>
                  <TableCell sx={{ color: '#000' }}>{row.name}</TableCell>
                  <TableCell sx={{ color: '#000' }}>{row.description}</TableCell>
                  <TableCell sx={{ color: '#000' }}>{findDataType(row.data_type_id).name}</TableCell>
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

export default Fields;
