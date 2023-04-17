import {NextPage} from 'next';
import {Box, Stack} from '@mui/system';
import ListHeader from '../../components/ListHeader';
import React, {useEffect, useRef, useState} from 'react';
import LoadingMessage from '../../components/LoadingMessage';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle, Table, TableBody,
  TableCell, TableContainer,
  TableHead,
  TableRow,
  TextField, Typography
} from '@mui/material';
import { StackItem } from '../../components/StackItem';
import {NamespaceDto} from 'objectified-data/dist/src/dto/namespace.dto';
import axios from 'axios';
import {alertDialog, confirmDialog, errorDialog} from '../../components/dialogs/ConfirmDialog';
import Paper from '@mui/material/Paper';
import {CheckBox, CheckBoxOutlineBlank, Delete, DeleteOutline, Edit, EditOutlined} from '@mui/icons-material';
import {loadNamespaces} from "../../components/data/namespaces";
import SectionHeader from "../../components/SectionHeader";

const Namespaces: NextPage = () => {
  const [namespaces, setNamespaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [addNamespaceShowing, setAddNamespaceShowing] = useState(false);
  const namespaceRef = useRef<HTMLInputElement>();

  const addNamespaceClicked = () => setAddNamespaceShowing(true);

  const reloadNamespaces = () => {
    setLoading(true);

    loadNamespaces(setNamespaces)
      .then(() => setLoading(false));
  }

  const addNamespace = () => {
    const namespaceValue = namespaceRef?.current?.value ?? '';

    if (namespaceValue.length > 0) {
      const namespace: any = {};

      namespace.name = namespaceValue;
      namespace.description = namespaceValue;
      namespace.enabled = true;

      axios.post('/app/namespaces/create', namespace)
        .then((x) => {
          setAddNamespaceShowing(false);
          reloadNamespaces();
        })
        .catch((x) => {
          errorDialog(x.message);
        });
    } else {
      return errorDialog('Namespace is missing a value.');
    }
  }

  const namespaceList = () => {
    if (namespaces.length === 0) {
      return (
        <>
          <Stack direction={'row'}>
            <StackItem sx={{ width: '100%', padding: '1em', color: '#000' }}>
              <Typography fontWeight={ 'bold' }>No namespaces have been defined yet.</Typography>
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
            {namespaces.map((row) => (
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

  useEffect(() => reloadNamespaces(), []);

  if (loading) {
    return (
      <LoadingMessage label={'Retrieving namespace list, one moment ...'} />
    );
  }

  return (
    <>
      <div sx={{ width: '100%' }} style={{ border: '1px solid #ddd', backgroundColor: '#fff' }}>
        <Dialog open={addNamespaceShowing} maxWidth={'sm'} fullWidth>
          <DialogTitle>Namespace</DialogTitle>
          <DialogContent>
            <Stack direction={'row'}>

              <StackItem sx={{ width: '100%', padding: '1em' }}>
                <TextField id={'namespace'} label={'Namespace'} variant={'outlined'} required inputRef={namespaceRef} fullWidth/>
              </StackItem>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => addNamespace()} variant={'contained'}>Add</Button>
            <Button onClick={() => setAddNamespaceShowing(false)} variant={'contained'} color={'error'}>Cancel</Button>
          </DialogActions>
        </Dialog>

        <SectionHeader header={'Namespaces'} onAdd={() => addNamespaceClicked()}>
          <Typography>
            Namespaces are logical groupings of classes, objects, and definitions, grouped by a unique identifier.
          </Typography>
        </SectionHeader>

        {namespaceList()}
      </div>
    </>
  );
}

export default Namespaces;
