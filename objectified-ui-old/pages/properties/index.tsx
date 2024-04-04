import {NextPage} from 'next';
import {Box, Stack} from '@mui/system';
import React, {useEffect, useRef, useState} from 'react';
import LoadingMessage from '../../components/LoadingMessage';
import {
  Button, Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle, FormControl, FormControlLabel, InputLabel, Select, SelectChangeEvent, Table, TableBody,
  TableCell, TableContainer,
  TableHead,
  TableRow,
  TextField, Typography
} from '@mui/material';
import { StackItem } from '../../components/StackItem';
import axios from 'axios';
import {CheckBox, CheckBoxOutlineBlank, Delete, DeleteOutline, Edit, EditOutlined} from '@mui/icons-material';
import MenuItem from '@mui/material/MenuItem';
import {errorDialog} from '../../components/dialogs/ConfirmDialog';
import {loadProperties} from "../../components/data/properties";
import SectionHeader from "../../components/SectionHeader";

const Properties: NextPage = () => {
  const [properties, setProperties] = useState([]);
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fieldId, setFieldId] = useState('0');
  const [isRequired, setIsRequired] = useState(false);
  const [isNullable, setIsNullable] = useState(false);
  const [isArray, setIsArray] = useState(false);
  const [isIndexed, setIsIndexed] = useState(false);
  const [addPropertiesShowing, setAddPropertiesShowing] = useState(false);
  const nameRef = useRef<HTMLInputElement>();
  const descriptionRef = useRef<HTMLInputElement>();
  const defaultValueRef = useRef<HTMLInputElement>();

  const addPropertyClicked = () => setAddPropertiesShowing(true);

  const reloadProperties = () => {
    setLoading(true);
    loadProperties(setProperties)
      .then(() => setLoading(false));
  }

  const addProperty = () => {
    const nameValue = nameRef?.current?.value ?? '';
    const descriptionValue = descriptionRef?.current?.value ?? '';
    const defaultValue = defaultValueRef?.current?.value ?? '';

    if (nameValue.length > 0 && descriptionValue.length > 0 && fieldId !== '0') {
      const propertyObject: any = {};

      propertyObject.name = nameValue;
      propertyObject.description = descriptionValue;
      propertyObject.field = {
        id: fieldId,
      };
      propertyObject.required = isRequired;
      propertyObject.nullable = isNullable;
      propertyObject.isArray = isArray;
      propertyObject.defaultValue = defaultValue;
      propertyObject.enabled = true;
      propertyObject.indexed = isIndexed;

      axios.post('/app/property/create', propertyObject)
        .then((x) => {
          setAddPropertiesShowing(false);
          reloadProperties();

          setFieldId('0');
          setIsRequired(false);
          setIsNullable(false);
          setIsArray(false);
          setIsIndexed(false);
        })
        .catch((x) => {
          errorDialog(x.message);
        });
    } else {
      return errorDialog('Property requires a name, a description, and a field type');
    }
  }

  const propertiesList = () => {
    if (properties.length === 0) {
      return (
        <>
          <Stack direction={'row'}>
            <StackItem sx={{ width: '100%', padding: '1em', color: '#000' }}>
              <Typography fontWeight={ 'bold' }>No properties have been defined yet.</Typography>
            </StackItem>
          </Stack>
        </>
      );
    }

    return (
      <TableContainer component={Box}>
        <Table sx={{ minWidth: 650, backgroundColor: '#fff' }} aria-label={'namespace table'}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd' }}>ID</TableCell>
              <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd' }}>Name</TableCell>
              <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd' }}>Description</TableCell>
              <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd', textAlign: 'center' }}>Enabled</TableCell>
              <TableCell sx={{ fontWeight: 'bold', borderTop: '1px solid #ddd' }}>Create Date</TableCell>
              <TableCell sx={{ borderTop: '1px solid #ddd' }}/>
            </TableRow>
          </TableHead>
          <TableBody>
            {properties.map((row) => (
              <>
                <TableRow hover>
                  <TableCell>{row.id}</TableCell>
                  <TableCell>{row.name}</TableCell>
                  <TableCell>{row.description}</TableCell>
                  <TableCell sx={{ textAlign: 'center' }}>{row.enabled ? <CheckBox/> : <CheckBoxOutlineBlank/>}</TableCell>
                  <TableCell>{row.create_date}</TableCell>
                  <TableCell align={'right'}><EditOutlined/> <Delete sx={{ color: 'red' }}/></TableCell>
                </TableRow>
              </>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    );
  }

  const handleFieldIdChanged = (event: SelectChangeEvent) => {
    setFieldId(event.target.value as string);
  }

  const handleIsRequiredChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    setIsRequired(event.target.checked);
  }

  const handleIsNullableChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    setIsNullable(event.target.checked);
  }

  const handleIsArrayChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    setIsArray(event.target.checked);
  }

  const handleIsIndexedChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    setIsIndexed(event.target.checked);
  }

  useEffect(() => reloadProperties(), []);

  useEffect(() => {
    axios.get('/app/fields/list')
      .then((result) => {
        setFields(result.data);
      });
  }, []);

  if (loading) {
    return (
      <LoadingMessage label={'Retrieving property list, one moment ...'} />
    );
  }

  return (
    <>
      <div sx={{ width: '100%' }} style={{ border: '1px solid #ddd', backgroundColor: '#fff' }}>
        <Dialog open={addPropertiesShowing} maxWidth={'sm'} fullWidth>
          <DialogTitle>Property</DialogTitle>
          <DialogContent>
            <Stack direction={'column'} sx={{ padding: '1em' }}>
              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'namespace'} label={'Property Name'} variant={'outlined'} required fullWidth inputRef={nameRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'description'} label={'Property Description'} variant={'outlined'} required fullWidth inputRef={descriptionRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <FormControl fullWidth required>
                  <InputLabel id={'field-label'} required>Field</InputLabel>
                  <Select labelId={'field-label'} fullWidth id={'field_id'} label={'Field'}
                          onChange={handleFieldIdChanged} value={fieldId}>
                    {fields.map((x) => (
                      <MenuItem value={x.id}>{x.name} ({x.description})</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px' }}>
                <TextField id={'default_value'} label={'Default Value'} variant={'outlined'} fullWidth inputRef={defaultValueRef}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px', verticalAlign: 'middle' }}>
                <FormControlLabel control={<Checkbox checked={isRequired} onChange={handleIsRequiredChanged}/>} label={'Value required'}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px', verticalAlign: 'middle' }}>
                <FormControlLabel control={<Checkbox checked={isNullable} onChange={handleIsNullableChanged}/>} label={'Is Nullable'}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px', verticalAlign: 'middle' }}>
                <FormControlLabel control={<Checkbox checked={isArray} onChange={handleIsArrayChanged}/>} label={'Is an array of values'}/>
              </StackItem>

              <StackItem sx={{ width: '100%', padding: '4px', verticalAlign: 'middle' }}>
                <FormControlLabel control={<Checkbox checked={isIndexed} onChange={handleIsIndexedChanged}/>} label={'Is an indexed property'}/>
              </StackItem>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => addProperty()} variant={'contained'}>Add</Button>
            <Button onClick={() => setAddPropertiesShowing(false)} variant={'contained'} color={'error'}>Cancel</Button>
          </DialogActions>
        </Dialog>

        <SectionHeader header={'Properties'} onAdd={() => addPropertyClicked()}>
          <Typography>
            Properties define an storage member that is defined by a <b>field</b>.  A <b>property</b> is used by
            a <b>class</b> to define the data that can be stored in a <b>class</b>.  Properties can be reused as many
            times as necessary, and can be indexed for faster data retrieval.  Properties are unique to each namespace.
          </Typography>
        </SectionHeader>

        {propertiesList()}
      </div>
    </>
  );
}

export default Properties;
