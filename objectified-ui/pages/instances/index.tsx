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
import { loadClasses } from '../../components/data/classes';
import SectionHeader from "../../components/SectionHeader";
import PropertySection from "../classProperties/propertySection";
import InstanceSection from "./instanceSection";

const Instances: NextPage = () => {
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [addInstanceShowing, setAddInstanceShowing] = useState(false);
  const nameRef = useRef<HTMLInputElement>();
  const descriptionRef = useRef<HTMLInputElement>();

  const addInstanceClicked = () => setAddInstanceShowing(true);

  const reloadClasses = () => {
    setLoading(true);

    loadClasses(setClasses)
      .then(() => setLoading(false));
  }

  const addInstance = () => {
    const nameValue = nameRef?.current?.value ?? '';
    const descriptionValue = descriptionRef?.current?.value ?? '';

    if (nameValue.length > 0 && descriptionValue.length > 0) {
      const classObject: any = {};

      classObject.name = nameValue;
      classObject.description = descriptionValue;
      classObject.enabled = true;

      axios.post('/app/classes/create', classObject)
        .then((x) => {
          setAddInstanceShowing(false);
          reloadClasses();
        })
        .catch((x) => {
          errorDialog(x.message);
        });
    } else {
      return errorDialog('Class requires a name and a description.');
    }
  }

  const classesList = () => {
    if (classes.length === 0) {
      return (
        <>
          <Stack direction={'row'}>
            <StackItem sx={{width: '100%', padding: '1em', color: '#000'}}>
              <Typography fontWeight={'bold'}>No classes have been defined yet.</Typography>
            </StackItem>
          </Stack>
        </>
      );
    }

    return classes.map((row) => (
      <InstanceSection name={row.name} description={row.description} id={row.id}/>
    ));

    // if (classes.length === 0) {
    //   return (
    //     <>
    //       <Stack direction={'row'}>
    //         <StackItem sx={{ width: '100%', padding: '1em', color: '#000' }}>
    //           <Typography fontWeight={ 'bold' }>No classes have been defined yet.</Typography>
    //         </StackItem>
    //       </Stack>
    //     </>
    //   );
    // }
    //
    // return (
    //   <TableContainer component={Box}>
    //     <Table sx={{ minWidth: 650, backgroundColor: '#fff' }} aria-label={'namespace table'}>
    //       <TableHead>
    //         <TableRow>
    //           <TableCell sx={{ fontWeight: 'bold' }}>ID</TableCell>
    //           <TableCell sx={{ fontWeight: 'bold' }}>Name</TableCell>
    //           <TableCell sx={{ fontWeight: 'bold' }}>Description</TableCell>
    //           <TableCell sx={{ fontWeight: 'bold', textAlign: 'center' }}>Enabled</TableCell>
    //           <TableCell sx={{ fontWeight: 'bold' }}>Create Date</TableCell>
    //           <TableCell/>
    //         </TableRow>
    //       </TableHead>
    //       <TableBody>
    //         {classes.map((row) => (
    //           <>
    //             <TableRow hover>
    //               <TableCell>{row.id}</TableCell>
    //               <TableCell>{row.name}</TableCell>
    //               <TableCell>{row.description}</TableCell>
    //               <TableCell sx={{ textAlign: 'center' }}>{row.enabled ? <CheckBox/> : <CheckBoxOutlineBlank/>}</TableCell>
    //               <TableCell>{row.create_date}</TableCell>
    //               <TableCell align={'right'}><EditOutlined/> <Delete sx={{ color: 'red' }}/></TableCell>
    //             </TableRow>
    //           </>
    //         ))}
    //       </TableBody>
    //     </Table>
    //   </TableContainer>
    // );
  }

  useEffect(() => reloadClasses(), []);

  if (loading) {
    return (
      <LoadingMessage label={'Retrieving class list, one moment ...'} />
    );
  }

  return (
    <>
      <div sx={{ width: '100%' }} style={{ border: '1px solid #ddd', backgroundColor: '#fff' }}>
        {/*<Dialog open={addInstanceShowing} maxWidth={'sm'} fullWidth>*/}
        {/*  <DialogTitle>Instance</DialogTitle>*/}
        {/*  <DialogContent>*/}
        {/*    <Stack direction={'column'} sx={{ padding: '1em' }}>*/}
        {/*      <StackItem sx={{ width: '100%', padding: '4px' }}>*/}
        {/*        <TextField id={'namespace'} label={'Class Name'} variant={'outlined'} required inputRef={nameRef} fullWidth/>*/}
        {/*      </StackItem>*/}

        {/*      <StackItem sx={{ width: '100%', padding: '4px' }}>*/}
        {/*        <TextField id={'namespace'} label={'Description'} variant={'outlined'} required inputRef={descriptionRef} fullWidth/>*/}
        {/*      </StackItem>*/}
        {/*    </Stack>*/}
        {/*  </DialogContent>*/}
        {/*  <DialogActions>*/}
        {/*    <Button onClick={() => addInstance()} variant={'contained'}>Add</Button>*/}
        {/*    <Button onClick={() => setAddInstanceShowing(false)} variant={'contained'} color={'error'}>Cancel</Button>*/}
        {/*  </DialogActions>*/}
        {/*</Dialog>*/}

        <SectionHeader header={'Instances'}>
          <Typography>
            Instances are records of data that conform to a Class definition, based on its defined ClassProperties
            schema records.  Instances are unique to each namespace.
          </Typography>
        </SectionHeader>

        {classesList()}
      </div>
    </>
  );
}

export default Instances;
