import { NextPage } from "next";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle, FormControl, InputLabel, Select, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow,
  TextField,
  Typography
} from '@mui/material';
import {Box, Stack} from '@mui/system';
import {StackItem} from '../../components/StackItem';
import {CheckBox, CheckBoxOutlineBlank, Delete} from '@mui/icons-material';
import React, {useEffect, useState} from 'react';
import axios from 'axios';
import LoadingMessage from '../../components/LoadingMessage';
import MenuItem from '@mui/material/MenuItem';

const DataTypes: NextPage = () => {
  const [loading, setLoading] = useState(true);
  const [dataTypes, setDataTypes] = useState([]);
  const [addDataTypeShowing, setAddDataTypeShowing] = useState(false);

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

  const addDataType = () => {

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
        <Dialog open={addDataTypeShowing}>
          <DialogTitle>Data Type</DialogTitle>
          <DialogContent>
            <Stack direction={'column'}>

              <StackItem sx={{ width: '100%' }}>
                {/*<TextField id={'namespace'} label={'Namespace'} variant={'outlined'} required inputRef={namespaceRef}/>*/}
                <TextField id={'name'} label={'Name'} variant={'outlined'} required fullWidth/>
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                <TextField id={'description'} label={'Description'} variant={'outlined'} required fullWidth/>
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
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

              <StackItem sx={{ width: '100%' }}>
                is_array BOOLEAN NOT NULL DEFAULT false,
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                max_length INT NOT NULL DEFAULT 0,
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                pattern TEXT,
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                enum_values TEXT[],
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                enum_descriptions TEXT[],
              </StackItem>

              <StackItem sx={{ width: '100%' }}>
                examples TEXT[],
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
