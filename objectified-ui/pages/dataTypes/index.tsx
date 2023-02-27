import { NextPage } from "next";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle, Table, TableBody, TableCell,
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

const DataTypes: NextPage = () => {
  const [loading, setLoading] = useState(true);
  const [dataTypes, setDataTypes] = useState([]);

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
  };

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
              <TableCell sx={{ fontWeight: 'bold' }}>Enabled</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>Create Date</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>Update Date</TableCell>
              <TableCell></TableCell>
            </TableRow>
          </TableHead>
          {dataTypes.map((row) => (
            <TableRow>
              <TableCell sx={{ color: '#000' }}>{row.id}</TableCell>
              <TableCell sx={{ color: '#000' }}>{row.name}</TableCell>
              <TableCell sx={{ color: '#000' }}>{row.description}</TableCell>
              <TableCell sx={{ color: '#000' }}>{row.data_type}</TableCell>
              <TableCell sx={{ color: '#000' }}>{row.enabled ? <CheckBox/> : <CheckBoxOutlineBlank/>}</TableCell>
              <TableCell sx={{ color: '#000' }}>{row.create_date}</TableCell>
              <TableCell sx={{ color: '#000' }}>{row.update_date}</TableCell>
              <TableCell align={'right'}><Delete sx={{ color: 'red' }}/></TableCell>
            </TableRow>
          ))}
        </Table>
      </TableContainer>
    </>
  );
}

export default DataTypes;
